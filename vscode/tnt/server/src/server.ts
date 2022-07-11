/* ----------------------------------------------------------------------------------
 * Copyright (c) Informal Systems 2021. All rights reserved.
 * Licensed under the Apache 2.0.
 * See License.txt in the project root for license information.
 * --------------------------------------------------------------------------------- */
import {
  createConnection,
  TextDocuments,
  Diagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  InitializeParams,
  DidChangeConfigurationNotification,
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  InitializeResult,
  Hover,
  MarkupKind,
  HoverParams,
  DocumentUri,
} from 'vscode-languageserver/node';

import {
  TextDocument
} from 'vscode-languageserver-textdocument';

import { parsePhase1, parsePhase2, Loc, DefinitionTableByModule, inferEffects, getSignatures, TntModule, effectToString, errorTreeToString } from 'tntc';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
  const capabilities = params.capabilities;

  // Does the client support the `workspace/configuration` request?
  // If not, we fall back using global settings.
  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  );
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && !!capabilities.workspace.workspaceFolders
  );
  hasDiagnosticRelatedInformationCapability = !!(
    capabilities.textDocument &&
    capabilities.textDocument.publishDiagnostics &&
    capabilities.textDocument.publishDiagnostics.relatedInformation
  );

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      // Tell the client that this server supports code completion.
      completionProvider: {
        resolveProvider: true
      },
      hoverProvider: true
    }
  };
  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: true
      }
    };
  }
  return result;
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    // Register for all configuration changes.
    connection.client.register(DidChangeConfigurationNotification.type, undefined);
  }
  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders(_event => {
      connection.console.log('Workspace folder change event received.');
    });
  }
});

// The example settings
interface ExampleSettings {
  maxNumberOfProblems: number;
}
// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000 };
let globalSettings: ExampleSettings = defaultSettings;


// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
  if (hasConfigurationCapability) {
    // Reset all cached document settings
    documentSettings.clear();
  } else {
    globalSettings = <ExampleSettings>(
      (change.settings.languageServerExample || defaultSettings)
    );
  }

  // Revalidate all open text documents
  documents.all().forEach(d => validateTextDocument(d).then(([tntModule, sourceMap, table]) => checkEffects(d, tntModule, sourceMap, table)));
});

function getDocumentSettings (resource: string): Thenable<ExampleSettings> {
  if (!hasConfigurationCapability) {
    return Promise.resolve(globalSettings);
  }
  let result = documentSettings.get(resource);
  if (!result) {
    result = connection.workspace.getConfiguration({
      scopeUri: resource,
      section: 'tntLspClient'
    });
    documentSettings.set(resource, result);
  }
  return result;
}

// Only keep settings for open documents
documents.onDidClose(e => {
  documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
  validateTextDocument(change.document).then(([tntModule, sourceMap, table]) => checkEffects(change.document, tntModule, sourceMap, table));
});

connection.onHover((params: HoverParams): Hover | undefined => {
  const position = params.position
  const effectsOnPosition: [string, string, Loc][] = []
  const effects = effectsByDocument.get(params.textDocument.uri)
  if (effects === undefined) {
    return
  }
  effects.forEach((effect, loc) => {
    if (position.line >= loc.start.line && (!loc.end || position.line <= loc.end.line) && position.character >= loc.start.col && (!loc.end || position.character <= loc.end.col)) {
      const text = documentsByUri.get(params.textDocument.uri)!.getText({ start: { line: loc.start.line, character: loc.start.col }, end: loc.end ? { line: loc.end.line, character: loc.end.col + 1 } : { line: loc.start.line, character: loc.start.col } })
      effectsOnPosition.push([text, effect, loc])
    }
  })
  const sortedEffects = effectsOnPosition.sort(([_t1, _e1, a], [_t2, _e2, b]) => {
    if (!a.end) {
      return -1
    } else if (!b.end) {
      return 1
    } else if (a.end.index - a.start.index > b.end.index - b.start.index) {
      return 1
    } else {
      return -1
    }
  }).map(([t, e, _]) => `${t}: ${e}`)

  return {
    contents: {
      kind: MarkupKind.PlainText,
      value: sortedEffects[0]
    }
  }
})

function assembleDiagnostic (explanation: string, loc: Loc): Diagnostic {
  return {
    severity: DiagnosticSeverity.Error,
    range: {
      start: { line: loc.start.line, character: loc.start.col },
      end: {
        line: loc.end ? loc.end.line : loc.start.line,
        character: loc.end ? loc.end.col + 1 : loc.start.col
      },
    },
    message: explanation,
    source: "parser"
  };
}

async function validateTextDocument (textDocument: TextDocument): Promise<[TntModule, Map<BigInt, Loc>, DefinitionTableByModule]> {
  // In this simple example we get the settings for every validate run.
  const settings = await getDocumentSettings(textDocument.uri);

  // The validator creates diagnostics for all uppercase words length 2 and more
  const diagnostics: Diagnostic[] = [];
  const text = textDocument.getText();
  const result = parsePhase1(text, textDocument.uri);

  if (result.kind == "error") {
    for (let msg of result.messages) {
      const diags = msg.locs.map(loc => assembleDiagnostic(msg.explanation, loc))
      diagnostics.push(...diags)
    }
  } else {
    const result2 = parsePhase2(result.module, result.sourceMap);
    if (result2.kind == "error") {
      for (let msg of result2.messages) {
        const diags = msg.locs.map(loc => assembleDiagnostic(msg.explanation, loc))
        diagnostics.push(...diags)
      }
    } else {
      return new Promise((resolve, reject) => resolve([result.module, result.sourceMap, result2.table]))
    }
  }

  // Send the computed diagnostics to VSCode.
  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
  return new Promise((resolve, reject) => reject(diagnostics))
}

const effectsByDocument: Map<DocumentUri, Map<Loc, string>> = new Map<DocumentUri, Map<Loc, string>>()
const documentsByUri: Map<DocumentUri, TextDocument> = new Map<DocumentUri, TextDocument>()

function checkEffects (textDocument: TextDocument, tntModule: TntModule, sourceMap: Map<BigInt, Loc>, table: DefinitionTableByModule) {
  const result = inferEffects(getSignatures(), table, tntModule)
  const diagnostics: Diagnostic[] = [];
  const effects: Map<Loc, string> = new Map<Loc, string>()
  result.mapLeft(e => {
    e.forEach((error, id) => {
      const loc = sourceMap.get(id)!
      const diag = assembleDiagnostic(errorTreeToString(error), loc)
      diagnostics.push(diag)
    })
  }).map(inferredEffects => {
    inferredEffects.forEach((effect, id) => effects.set(sourceMap.get(id)!, effectToString(effect)))
    effectsByDocument.set(textDocument.uri, effects)
    documentsByUri.set(textDocument.uri, textDocument)
  })
  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles(_change => {
  // Monitored files have change in VSCode
  connection.console.log('We received a file change event');
});

// This handler provides the initial list of the completion items.
connection.onCompletion(
  (_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
    // The pass parameter contains the position of the text document in
    // which code complete got requested. For the example we ignore this
    // info and always provide the same completion items.
    return [
      {
        label: 'TypeScript',
        kind: CompletionItemKind.Text,
        data: 1
      },
      {
        label: 'JavaScript',
        kind: CompletionItemKind.Text,
        data: 2
      }
    ];
  }
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
  (item: CompletionItem): CompletionItem => {
    if (item.data === 1) {
      item.detail = 'TypeScript details';
      item.documentation = 'TypeScript documentation';
    } else if (item.data === 2) {
      item.detail = 'JavaScript details';
      item.documentation = 'JavaScript documentation';
    }
    return item;
  }
);

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
