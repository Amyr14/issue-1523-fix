/* ----------------------------------------------------------------------------------
 * Copyright (c) Informal Systems 2022. All rights reserved.
 * Licensed under the Apache 2.0.
 * See License.txt in the project root for license information.
 * --------------------------------------------------------------------------------- */

/**
 * Essentials for handling Effects: unification, simplification and substitutions
 *
 * @author Gabriela Moreira
 *
 * @module
 */

import { effectToString, variablesToString } from './printing'
import { Either, merge, right, left, mergeInMany } from '@sweet-monads/either'

/* Concrete atomic efects specifying variables that the expression reads and updates */
interface ConcreteEffect { kind: 'concrete', read: Variables, update: Variables }

/* Arrow effects for expressions with effects depending on parameters */
interface ArrowEffect { kind: 'arrow', params: Effect[], result: Effect }

/*
 * The effect of a TNT expression, regarding which state variables are read
 * and/or updated
 */
export type Effect =
  /* A quantification variable, referring to an effect */
  | { kind: 'quantified', name: string }
  | ConcreteEffect
  | ArrowEffect

/*
 * The variables an effect acts upon. Either a list of state variables, a
 * quantification over them or a combination of other variables.
 * Uses the plural form since all forms represent a plurality of variables.
 */
export type Variables =
  /* A list of state variables */
  | { kind: 'concrete', vars: string[] }
  /* A quantification variable, referring to an array of state variables, to be substituted */
  | { kind: 'quantified', name: string }
  /* A combination of variables to be computed as a union when concrete */
  | { kind: 'union', variables: Variables[] }

/*
 * A tree of errors tracking the trace from the full given effect(s) to the part
 * where the error occurred
 */
export interface ErrorTree {
  /* The error message, used for the terminal node where the error occurred */
  message?: string,
  /* A description of the context within which the current node is encountered */
  location: string,
  /* The node's children */
  children: ErrorTree[]
}

export type Signature = (arity: number) => Effect

/*
 * A simple disjunction over error representations to make it easier to chain
 * different operations and handle errors all at once (see buildErrorTree())
 * */
type Error = ErrorTree | ErrorTree[]

/*
 * Substitutions can be applied to both effects and variables, replacing
 * quantified values with concrete ones
 */
export type Substitution =
  | { kind: 'variable', name: string, value: Variables }
  | { kind: 'effect', name: string, value: Effect }

/*
 * A shortcut to writting the empty set of variables
 */
export const emptyVariables: Variables = { kind: 'concrete', vars: [] }

/**
 * Unifies two effects by matching effect types and unifying their variables.
 *
 * @param ea an effect to be unified
 * @param eb the effect to be unified with
 *
 * @returns an array of substitutions that unifies both effects, when possible.
 *          Otherwise, an error tree with an error message and its trace.
 */
export function unify (ea: Effect, eb: Effect): Either<ErrorTree, Substitution[]> {
  const location = `Trying to unify ${effectToString(ea)} and ${effectToString(eb)}`

  const simplificationResults = mergeInMany([ea, eb].map(e => {
    return e.kind === 'concrete' ? simplifyConcreteEffect(e) : right(e)
  }))
  return simplificationResults.chain(([e1, e2]): Either<Error, Substitution[]> => {
    if (e1.kind === 'arrow' && e2.kind === 'arrow') {
      return unifyArrows(location, e1, e2)
    } else if (e1.kind === 'concrete' && e2.kind === 'concrete') {
      return unifyConcrete(location, e1, e2)
    } else if (e1.kind === 'quantified') {
      return bindEffect(e1.name, e2)
        .map(subs => [subs])
        .mapLeft(msg => buildErrorLeaf(location, msg))
    } else if (e2.kind === 'quantified') {
      return bindEffect(e2.name, e1)
        .map(subs => [subs])
        .mapLeft(msg => buildErrorLeaf(location, msg))
    } else {
      return left({
        location: location,
        message: "Can't unify different types of effects",
        children: [],
      })
    }
  }).mapLeft(error => buildErrorTree(location, error))
}

function unifyArrows (location: string, e1: ArrowEffect, e2: ArrowEffect) {
  if (e1.params.length !== e2.params.length) {
    const expected = e1.params.length
    const got = e2.params.length
    return left({
      location: location,
      message: `Expected ${expected} arguments, got ${got}`,
      children: [],
    })
  }

  function applySubstitutionsAndUnify (subs: Substitution[], e1: Effect, e2: Effect): Either<Error, Substitution[]> {
    const effectsWithSubstitutions = mergeInMany([
      applySubstitution(subs, e1),
      applySubstitution(subs, e2),
    ])
    const newSubstitutions = effectsWithSubstitutions.chain(es => unify(...es))
    return newSubstitutions.chain(newSubs => compose(subs, newSubs))
  }

  const paramsUnification = e1.params.reduce((result: Either<Error, Substitution[]>, e, i) => {
    return result.chain(subs => applySubstitutionsAndUnify(subs, e, e2.params[i]))
  }, right([]))

  return paramsUnification.chain(subs => applySubstitutionsAndUnify(subs, e1.result, e2.result))
}

export function compose (s1: Substitution[], s2: Substitution[]): Either<ErrorTree, Substitution[]> {
  return mergeInMany(s2.map(s => applySubstitutionsToSubstitution(s1, s)))
    .map((s: Substitution[]) => s1.concat(s))
    .mapLeft(error => buildErrorTree(`Composing substitutions ${s1} and ${s2}`, error))
}

function applySubstitutionsToSubstitution (subs: Substitution[], s: Substitution): Either<ErrorTree, Substitution> {
  switch (s.kind) {
    case 'effect': return applySubstitution(subs, s.value).map(v => ({ kind: s.kind, name: s.name, value: v }))
    case 'variable': return right({ kind: s.kind, name: s.name, value: applySubstitutionToVariables(subs, s.value) })
  }
}

function unifyConcrete (location: string, e1: ConcreteEffect, e2: ConcreteEffect) {
  const readUnificationResult = unifyVariables(e1.read, e2.read)
  const updateUnificationResult = readUnificationResult.chain(subs => {
    const effectsWithReadSubstitution = mergeInMany([
      applySubstitution(subs, e1),
      applySubstitution(subs, e2),
    ]).map(effects => effects.map(ensureConcreteEffect))

    return effectsWithReadSubstitution.chain(([e1s, e2s]) => unifyVariables(e1s.update, e2s.update))
  })

  return merge([readUnificationResult, updateUnificationResult]).map(s => s.flat())
}

function unifyVariables (va: Variables, vb: Variables): Either<ErrorTree, Substitution[]> {
  const v1 = flattenUnions(va)
  const v2 = flattenUnions(vb)
  const location = `Trying to unify variables [${variablesToString(v1)}] and [${variablesToString(v2)}]`

  if (v1.kind === 'concrete' && v2.kind === 'concrete') {
    // Both state
    if (sameVars(v1.vars, v2.vars)) {
      return right([])
    } else {
      return left({
        location: location,
        message: `Expected variables [${v1.vars}] and [${v2.vars}] to be the same`,
        children: [],
      })
    }
  } else if (v1.kind === 'quantified' && v2.kind === 'quantified' && v1.name === v2.name) {
    return right([])
  } else if (v1.kind === 'quantified') {
    return bindVariables(v1.name, v2)
      .map(subs => [subs])
      .mapLeft(msg => buildErrorLeaf(location, msg))
  } else if (v2.kind === 'quantified') {
    return bindVariables(v2.name, v1)
      .map(subs => [subs])
      .mapLeft(msg => buildErrorLeaf(location, msg))
  } else {
    if (JSON.stringify(v1) === JSON.stringify(v2)) {
      return right([])
    }

    // At least one of the variables is a union
    // Unifying sets is complicated and we should never have to do this in TNT's
    // use case for this effect system
    return left({
      location: location,
      message: 'Unification for unions of variables is not implemented',
      children: [],
    })
  }
}

/**
 * Applies substitutions to an effect, replacing all quantified names with their
 * substitution values when they are defined.
 *
 * @param subs the substitutions to be applied
 * @param e the effect to be transformed
 *
 * @returns the effect resulting from the substitutions application on the given
 *          effect, when successful. Otherwise, an error tree with an error message and its trace.
 */
export function applySubstitution (subs: Substitution[], e: Effect): Either<ErrorTree, Effect> {
  let result: Either<ErrorTree, Effect> = right(e)
  switch (e.kind) {
    case 'quantified': {
      // e is an effect variable
      const sub = subs.find(s => s.name === e.name)
      if (sub && sub.kind === 'effect') {
        result = right(sub.value)
      }
      break
    }
    case 'arrow': {
      // e takes effects as parameters and returs an effect as result
      const arrowParams = mergeInMany(e.params.map(ef => applySubstitution(subs, ef)))
      result = arrowParams.chain(ps => {
        const arrowResult = applySubstitution(subs, e.result)
        return arrowResult.map(r => ({ kind: e.kind, params: ps, result: r }))
      }).mapLeft(error => buildErrorTree(`Applying substitution to arrow effect ${effectToString(e)}`, error))
      break
    }
    case 'concrete': {
      // e is a an effect of the form Read[r] & Update[u]
      const read = applySubstitutionToVariables(subs, e.read)
      const update = applySubstitutionToVariables(subs, e.update)

      result = right({ kind: 'concrete', read: read, update: update })
      break
    }
  }

  return result.chain(e => e.kind === 'concrete' ? simplifyConcreteEffect(e) : right(e))
}

function simplifyConcreteEffect (e: ConcreteEffect): Either<ErrorTree, Effect> {
  const read = uniqueVariables(flattenUnions(e.read))
  const update = flattenUnions(e.update)

  const updateVars = findVars(e.update)
  const repeated = updateVars.filter(v => updateVars.filter(v2 => v === v2).length > 1)
  if (repeated.length > 0) {
    return left({
      location: `Trying to simplify effect ${effectToString(e)}`,
      message: `Multiple updates of variable(s): ${Array.from(new Set(repeated))}`,
      children: [],
    })
  } else {
    return right({ kind: 'concrete', read: read, update: update })
  }
}

function findVars (variables: Variables): string[] {
  switch (variables.kind) {
    case 'quantified':
      return []
    case 'concrete':
      return variables.vars
    case 'union':
      return variables.variables.flatMap(findVars)
  }
}

function flattenUnions (variables: Variables): Variables {
  switch (variables.kind) {
    case 'union': {
      const unionVariables: Variables[] = []
      const vars: string[] = []
      const flattenVariables = variables.variables.map(v => flattenUnions(v))
      flattenVariables.forEach(v => {
        switch (v.kind) {
          case 'quantified':
            unionVariables.push(v)
            break
          case 'concrete':
            vars.push(...v.vars)
            break
          case 'union':
            unionVariables.push(...v.variables)
            break
        }
      })

      if (unionVariables.length > 0) {
        const variables = vars.length > 0 ? unionVariables.concat({ kind: 'concrete', vars: vars }) : unionVariables
        return variables.length > 1 ? { kind: 'union', variables: variables } : variables[0]
      } else {
        return { kind: 'concrete', vars: vars }
      }
    }
    default:
      return variables
  }
}

function uniqueVariables (variables: Variables): Variables {
  switch (variables.kind) {
    case 'quantified':
      return variables
    case 'concrete':
      return { kind: 'concrete', vars: Array.from(new Set<string>(variables.vars)) }
    case 'union': {
      const nestedVariables = variables.variables.map(v => uniqueVariables(v))
      return { kind: 'union', variables: Array.from(new Set<Variables>(nestedVariables)) }
    }
  }
}

export function applySubstitutionToVariables (subs: Substitution[], variables: Variables): Variables {
  switch (variables.kind) {
    case 'quantified': {
      const sub = subs.find(s => s.name === variables.name)
      if (sub && sub.kind === 'variable') {
        return sub.value
      }
      break
    }
    case 'union': {
      const newVariables = variables.variables.map(v => applySubstitutionToVariables(subs, v))
      return { kind: 'union', variables: newVariables }
    }
  }
  return variables
}

function bindEffect (name: string, effect: Effect): Either<string, Substitution> {
  if (effectNames(effect).includes({ kind: 'effect', name: name })) {
    return left(`Can't bind ${name} to ${effectToString(effect)}: cyclical binding`)
  } else {
    return right({ kind: 'effect', name: name, value: effect })
  }
}

function bindVariables (name: string, variables: Variables): Either<string, Substitution> {
  if (variablesNames(variables).includes({ kind: 'variable', name: name })) {
    return left(`Can't bind ${name} to ${variablesToString(variables)}: cyclical binding`)
  } else {
    return right({ kind: 'variable', name: name, value: variables })
  }
}

interface Name {
  kind: 'effect' | 'variable'
  name: string
}

export function effectNames (effect: Effect): Name[] {
  switch (effect.kind) {
    case 'concrete': return variablesNames(effect.read).concat(variablesNames(effect.update))
    case 'arrow': return effect.params.flatMap(effectNames).concat(effectNames(effect.result))
    case 'quantified': return [{ kind: 'effect', name: effect.name }]
  }
}

export function variablesNames (variables: Variables): Name[] {
  switch (variables.kind) {
    case 'concrete': return []
    case 'quantified': return [{ kind: 'variable', name: variables.name }]
    case 'union': return variables.variables.flatMap(variablesNames)
  }
}

function buildErrorTree (location: string, errors: Error): ErrorTree {
  if (!Array.isArray(errors) && location === errors.location) {
    // Avoid redundant locations
    return errors
  }

  return { location: location, children: Array.isArray(errors) ? errors : [errors] }
}

function buildErrorLeaf (location: string, message: string): ErrorTree {
  return { location: location, message: message, children: [] }
}

// Ensure the type system that an effect has the 'concrete' kind
function ensureConcreteEffect (e: Effect): ConcreteEffect {
  if (e.kind !== 'concrete') {
    throw new Error(`Unexpected format on ${effectToString(e)} - should have kind 'concrete'`)
  }

  return e
}

function sameVars (v1: string[], v2: string[]): Boolean {
  const v1s = sortStrings(v1)
  const v2s = sortStrings(v2)

  return v1s.length === v2s.length && v1s.every((value, index) => value === v2s[index])
}

function sortStrings (array: string[]): string[] {
  return array.sort((n1, n2) => n1 > n2 ? 1 : -1)
}
