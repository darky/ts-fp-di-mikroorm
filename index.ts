import { EntityManager, EntitySchema, MikroORM } from '@mikro-orm/core'
import { types } from 'node:util'
import { diDep, diHas, diInit, diSet, als } from 'ts-fp-di'

type Entity = EntitySchema & {
  $forDelete?: boolean
  $forUpsert?: boolean
  $noPersist?: boolean
  [key: string]: unknown
}

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
  if (Array.isArray(maybeEntity)) {
    return arrayToSet(maybeEntity, entities)
  }
  if (types.isMap(maybeEntity)) {
    return arrayToSet(Array.from(maybeEntity.values()), entities)
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
  const upsertEntity = entity.$forUpsert
    ? await fetchExistingEntity(entity).then(ent =>
        ent
          ? (Object.entries(entity)
              .filter(([, v]) => v !== void 0)
              .forEach(([k, v]) => (ent[k] = v)),
            ent)
          : entity
      )
    : null

  if (entity.$forDelete) {
    em.remove(entity)
  } else {
    em.persist(upsertEntity ?? entity)
  }
}

const isEntity = (maybeEntity: unknown): maybeEntity is Entity =>
  diDep<Set<unknown>>(TS_FP_DI_MIKROORM_ENTITIES).has(
    (Object.getPrototypeOf(maybeEntity ?? {}) as { constructor: unknown }).constructor
  )
