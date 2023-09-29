import { EntityManager, MikroORM } from '@mikro-orm/core'
import { types } from 'node:util'
import { diDep, diHas, diInit, diSet, als } from 'ts-fp-di'

const TS_FP_DI_MIKROORM_EM = 'ts-fp-di-mikroorm-em'
const TS_FP_DI_MIKROORM_ENTITIES = 'ts-fp-di-mikroorm-entities'
const TS_FP_DI_MIKROORM_ON_PERSIST_CB = 'ts-fp-di-mikroorm-on-persist-cb'

export const wrapTsFpDiMikroorm = async <T>(orm: MikroORM, cb: () => Promise<T>): Promise<T> => {
  return await diInit(async () => {
    const em = orm.em.fork()

    diSet(TS_FP_DI_MIKROORM_EM, em)
    diSet(TS_FP_DI_MIKROORM_ENTITIES, new Set(orm.config.get('entities')))

    const resp = await cb()

    persistIfEntity([
      ...(als.getStore()?.state.values() ?? []),
      ...(als.getStore()?.once.values() ?? []),
      ...(als.getStore()?.derived.values() ?? []),
    ])

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

const persistIfEntity = (maybeEntity: unknown) => {
  if (Array.isArray(maybeEntity)) {
    return maybeEntity.forEach(persistIfEntity)
  }
  if (types.isMap(maybeEntity)) {
    return Array.from(maybeEntity.values()).forEach(persistIfEntity)
  }
  if (!isEntity(maybeEntity)) {
    return
  }
  if (maybeEntity.$noPersist) {
    return
  }
  if (maybeEntity.$forDelete) {
    diDep<EntityManager>(TS_FP_DI_MIKROORM_EM).remove(maybeEntity)
  } else {
    diDep<EntityManager>(TS_FP_DI_MIKROORM_EM).persist(maybeEntity)
  }
}

const isEntity = (
  maybeEntity: unknown
): maybeEntity is { $forDelete?: boolean; $noPersist?: boolean; [key: string]: unknown } =>
  diDep<Set<unknown>>(TS_FP_DI_MIKROORM_ENTITIES).has(
    (Object.getPrototypeOf(maybeEntity ?? {}) as { constructor: unknown }).constructor
  )
