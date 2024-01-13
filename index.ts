import { EntityManager, EntitySchema, MikroORM } from '@mikro-orm/core'
import { types } from 'node:util'
import { diDep, diHas, diInit, diSet, als } from 'ts-fp-di'

type Entity = EntitySchema & {
  $forDelete?: boolean
  $forUpsert?: boolean
  $forUpdate?: boolean
  $noPersist?: boolean
  [key: string]: unknown
}

type Some = { _tag: 'Some'; value: unknown }
type Right = { _tag: 'Right'; right: unknown }
type Left = { _tag: 'Left'; left: unknown }

const TS_FP_DI_MIKROORM_EM = 'ts-fp-di-mikroorm-em'
const TS_FP_DI_MIKROORM_ENTITIES = 'ts-fp-di-mikroorm-entities'
const TS_FP_DI_MIKROORM_ON_PERSIST_CB = 'ts-fp-di-mikroorm-on-persist-cb'

export const wrapTsFpDiMikroorm = async <T>(orm: MikroORM, cb: () => Promise<T>): Promise<T> => {
  return await diInit(async () => {
    const em = orm.em.fork()

    diSet(TS_FP_DI_MIKROORM_EM, em)
    diSet(TS_FP_DI_MIKROORM_ENTITIES, new Set(orm.config.get('entities')))

    const resp = await cb()

    const allState = [
      ...(als.getStore()?.state.values() ?? []),
      ...(als.getStore()?.once.values() ?? []),
      ...(als.getStore()?.derived.values() ?? []),
    ]
    const entities = Array.from(entitiesSet(allState).values())
    const entitiesForUpsert = entities.filter(ent => !!ent.$forUpsert)

    await Promise.all(entitiesForUpsert.map(fetchExistingEntity))
    await Promise.all(entities.map(persistEntity))
    await em.flush()

    if (diHas(TS_FP_DI_MIKROORM_ON_PERSIST_CB)) {
      await diDep<() => Promise<void>>(TS_FP_DI_MIKROORM_ON_PERSIST_CB)()
    }

    return resp
  })
}

export const em = () => diDep<EntityManager>(TS_FP_DI_MIKROORM_EM)

export const onPersist = (cb: () => Promise<void>) => {
  diSet(TS_FP_DI_MIKROORM_ON_PERSIST_CB, cb)
}

export const entityConstructor = <T extends object>(self: T, ent: T) =>
  Object.entries(ent).forEach(([key, val]) => Reflect.set(self, key, val))

const entitiesSet = (maybeEntity: unknown, entities = new Set<Entity>()): Set<Entity> => {
  if (isLeft(maybeEntity) && maybeEntity.left instanceof Error) {
    throw maybeEntity.left
  }
  if (Array.isArray(maybeEntity)) {
    return arrayToSet(maybeEntity, entities)
  }
  if (types.isMap(maybeEntity) || types.isSet(maybeEntity)) {
    return arrayToSet(Array.from(maybeEntity.values()), entities)
  }
  if (isSome(maybeEntity)) {
    return entitiesSet(maybeEntity.value, entities)
  }
  if (isRight(maybeEntity)) {
    return entitiesSet(maybeEntity.right, entities)
  }
  if (!isEntity(maybeEntity)) {
    return entities
  }
  if (maybeEntity.$noPersist) {
    return entities
  }
  return new Set(entities).add(maybeEntity)
}

const arrayToSet = (maybeEntity: unknown[], entities: Set<Entity>) => {
  const sets = maybeEntity.map(maybeEnt => entitiesSet(maybeEnt, entities))
  const resp = new Set(entities)
  sets.forEach(set => Array.from(set.values()).forEach(ent => resp.add(ent)))
  return resp
}

const fetchExistingEntity = (entity: Entity) => {
  const em = diDep<EntityManager>(TS_FP_DI_MIKROORM_EM)
  const pks = em.getMetadata().get(entity.constructor.name).primaryKeys
  return em.findOne(entity.constructor, Object.fromEntries(pks.map(pk => [pk, entity[pk]])))
}

const persistEntity = async (entity: Entity) => {
  const em = diDep<EntityManager>(TS_FP_DI_MIKROORM_EM)

  if (entity.$forDelete) {
    return em.remove(entity)
  }

  const updated = entity.$forUpdate ? getRef(entity) : entity.$forUpsert ? await fetchExistingEntity(entity) : null

  if (updated) {
    Object.entries(entity)
      .filter(([, v]) => v !== void 0)
      .forEach(([k, v]) => (updated[k] = v))
  }

  return em.persist(updated ?? entity)
}

const isSome = (maybeEntity: unknown): maybeEntity is Some =>
  maybeEntity != null && (maybeEntity as Some)._tag === 'Some' && (maybeEntity as Some).value != null

const isRight = (maybeEntity: unknown): maybeEntity is Right =>
  maybeEntity != null && (maybeEntity as Right)._tag === 'Right' && (maybeEntity as Right).right != null

const isLeft = (maybeEntity: unknown): maybeEntity is Left =>
  maybeEntity != null && (maybeEntity as Left)._tag === 'Left' && (maybeEntity as Left).left != null

const isEntity = (maybeEntity: unknown): maybeEntity is Entity =>
  diDep<Set<unknown>>(TS_FP_DI_MIKROORM_ENTITIES).has(
    (Object.getPrototypeOf(maybeEntity ?? {}) as { constructor: unknown }).constructor
  )

const getRef = (entity: Entity) => {
  const em = diDep<EntityManager>(TS_FP_DI_MIKROORM_EM)

  return em.getReference(
    entity.constructor.name,
    em
      .getMetadata()
      .get(entity.constructor.name)
      .primaryKeys.map(pk => entity[pk])
  )
}
