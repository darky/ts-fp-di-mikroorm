import { Entity, EventArgs, EventSubscriber, MikroORM, PrimaryKey, Property, wrap } from '@mikro-orm/core'
import { EntityManager, defineConfig } from '@mikro-orm/better-sqlite'
import test, { afterEach, beforeEach } from 'node:test'
import { em, entityConstructor, onPersist, wrapTsFpDiMikroorm } from './index'
import assert from 'node:assert'
import { diDep, diMap, dic, dis } from 'ts-fp-di'

let orm: MikroORM
let insertedEntitiesViaEvent: unknown[] = []

@Entity()
class TestEntity {
  constructor(ent: Partial<TestEntity>) {
    entityConstructor(this, ent)
  }

  @PrimaryKey()
  id!: number

  @Property()
  value!: string

  @Property({ version: true })
  version!: number

  @Property({ defaultRaw: 'current_timestamp', type: 'Date' })
  createdAt?: Date

  $forDelete?: boolean

  $forUpsert?: boolean

  $noPersist?: boolean
}

export class MikroORMEventsSubscriber implements EventSubscriber {
  async beforeCreate(args: EventArgs<unknown>): Promise<void> {
    insertedEntitiesViaEvent.push(args.entity)
  }
}

const $store = dis(
  (state: TestEntity | null, payload: Partial<TestEntity>) =>
    state ? wrap(state).assign(payload) : payload instanceof TestEntity ? payload : new TestEntity(payload),
  null
)

const $storeArray = dis(
  (state: TestEntity[], payload: Partial<TestEntity>) => state.concat(new TestEntity(payload)),
  []
)

const $storeMap = dis(
  (state, payload: TestEntity) => new Map(state).set(payload.id, new TestEntity(payload)),
  new Map<number, TestEntity>()
)

const $const = dic<TestEntity>()

const $ref = dic<TestEntity>()

beforeEach(async () => {
  orm = await MikroORM.init(
    defineConfig({
      // dbName: 'test.sqlite',
      dbName: ':memory:',
      debug: true,
      entities: [TestEntity],
      subscribers: [new MikroORMEventsSubscriber()],
    })
  )
  await orm.getSchemaGenerator().dropSchema()
  await orm.getSchemaGenerator().createSchema()
  await orm.getSchemaGenerator().refreshDatabase()
  await orm.getSchemaGenerator().clearDatabase()
})

afterEach(async () => {
  insertedEntitiesViaEvent = []
  await orm.close()
})

test('persistance works for $store', async () => {
  await wrapTsFpDiMikroorm(orm, async () => {
    $store({ id: 1, value: 'test' })
  })

  const persisted = await orm.em.fork().findOne(TestEntity, { id: 1 })
  assert.strictEqual(persisted?.id, 1)
  assert.strictEqual(persisted?.value, 'test')
})

test('persistance works for $store (array)', async () => {
  await wrapTsFpDiMikroorm(orm, async () => {
    $storeArray({ value: 'test' })
    $storeArray({ value: 'test2' })
  })

  const persisted = await orm.em.fork().find(TestEntity, { $or: [{ id: 1 }, { id: 2 }] }, { orderBy: { id: 'ASC' } })
  assert.strictEqual(persisted[0]?.id, 1)
  assert.strictEqual(persisted[0]?.value, 'test')
  assert.strictEqual(persisted[1]?.id, 2)
  assert.strictEqual(persisted[1]?.value, 'test2')
})

test('persistance works for $store (map)', async () => {
  await wrapTsFpDiMikroorm(orm, async () => {
    $storeMap({ value: 'test', id: 1, version: 1 })
    $storeMap({ value: 'test2', id: 2, version: 1 })
  })

  const persisted = await orm.em.fork().find(TestEntity, { $or: [{ id: 1 }, { id: 2 }] }, { orderBy: { id: 'ASC' } })
  assert.strictEqual(persisted[0]?.id, 1)
  assert.strictEqual(persisted[0]?.value, 'test')
  assert.strictEqual(persisted[1]?.id, 2)
  assert.strictEqual(persisted[1]?.value, 'test2')
})

test('persistance works for $store (updating case)', async () => {
  await orm.em.fork().persistAndFlush(new TestEntity({ id: 1, value: 'test' }))

  await wrapTsFpDiMikroorm(orm, async () => {
    const exists = await em().findOne(TestEntity, { id: 1 })
    $store(exists!)
    $store({ value: 'test2' })
  })

  const persisted = await orm.em.fork().findOne(TestEntity, { id: 1 })
  assert.strictEqual(persisted?.id, 1)
  assert.strictEqual(persisted?.value, 'test2')
})

test('persistance works for $store (deleting case)', async () => {
  await orm.em.fork().persistAndFlush(new TestEntity({ id: 1, value: 'test' }))

  await wrapTsFpDiMikroorm(orm, async () => {
    const exists = await em().findOne(TestEntity, { id: 1 })
    $store(exists!)
    $store({ $forDelete: true })
  })

  const persisted = await orm.em.fork().findOne(TestEntity, { id: 1 })
  assert.strictEqual(persisted, null)
})

test('no persistance for not changed entity', async () => {
  await orm.em.fork().persistAndFlush(new TestEntity({ id: 1, value: 'test' }))
  insertedEntitiesViaEvent = []

  await wrapTsFpDiMikroorm(orm, async () => {
    const exists = await em().findOne(TestEntity, { id: 1 })
    $store(exists!)
  })

  assert.strictEqual(!!insertedEntitiesViaEvent.find(ent => ent instanceof TestEntity), false)
})

test('no persistance on error', async () => {
  await assert.rejects(async () => {
    await wrapTsFpDiMikroorm(orm, async () => {
      $store({ id: 1, value: 'test' })
      throw new Error('test-err')
    })
  }, new Error('test-err'))

  assert.strictEqual(await orm.em.fork().findOne(TestEntity, { id: 1 }), null)
})

test('optimistic lock', async () => {
  await orm.em.fork().persistAndFlush(new TestEntity({ id: 1, value: 'test' }))

  await assert.rejects(async () => {
    await wrapTsFpDiMikroorm(orm, async () => {
      const exists = await em().findOne(TestEntity, { id: 1 })
      exists && (exists.value = 'test2')
      await orm.em.fork().nativeUpdate(TestEntity, { id: 1 }, { value: 'test3' })
      $store(exists!)
    })
  })

  const persisted = await orm.em.fork().findOne(TestEntity, { id: 1 })
  assert.strictEqual(persisted?.id, 1)
  assert.strictEqual(persisted?.value, 'test3')
  assert.strictEqual(persisted?.version, 2)
})

test('onPersist success', async () => {
  await wrapTsFpDiMikroorm(orm, async () => {
    $store({ value: 'test' })
    onPersist(async () => {
      assert.deepStrictEqual(
        $store(),
        new TestEntity({ id: 1, value: 'test', version: 1, createdAt: $store()?.createdAt ?? new Date() })
      )
    })
  })
})

test('onPersist error', async () => {
  await assert.rejects(
    () =>
      wrapTsFpDiMikroorm(orm, async () => {
        onPersist(async () => {
          throw new Error('test-err')
        })
      }),
    new Error('test-err')
  )
})

test('wrapTsFpDiMikroorm response', async () => {
  const resp = await wrapTsFpDiMikroorm(orm, async () => 'test')
  assert.strictEqual(resp, 'test')
})

test('persistance works for $const', async () => {
  await wrapTsFpDiMikroorm(orm, async () => {
    $const(new TestEntity({ id: 1, value: 'test' }))
  })

  const persisted = await orm.em.fork().findOne(TestEntity, { id: 1 })
  assert.strictEqual(persisted?.id, 1)
  assert.strictEqual(persisted?.value, 'test')
})

test('persistance works for diMap', async () => {
  await wrapTsFpDiMikroorm(orm, async () => {
    const id = dic<number>()
    id(1)
    diMap(id => new TestEntity({ id, value: 'test' }), id)()
  })

  const persisted = await orm.em.fork().findOne(TestEntity, { id: 1 })
  assert.strictEqual(persisted?.id, 1)
  assert.strictEqual(persisted?.value, 'test')
})

test('ignore persistance', async () => {
  await wrapTsFpDiMikroorm(orm, async () => {
    $const(new TestEntity({ id: 1, value: 'test', $noPersist: true }))
  })

  const persisted = await orm.em.fork().findOne(TestEntity, { id: 1 })
  assert.strictEqual(persisted, null)
})

test('persistance deduplication', async () => {
  let persistCalls = 0
  await wrapTsFpDiMikroorm(orm, async () => {
    const em = diDep<EntityManager>('ts-fp-di-mikroorm-em')
    const origPersist = em.persist
    em.persist = function (...args) {
      persistCalls++
      return origPersist.apply(this, args)
    }
    const entity = new TestEntity({ id: 1, value: 'test' })
    $const(entity)
    $store(entity)
  })

  const persisted = await orm.em.fork().findOne(TestEntity, { id: 1 })
  assert.strictEqual(persisted?.id, 1)
  assert.strictEqual(persisted?.value, 'test')
  assert.strictEqual(persistCalls, 1)
})

test('reference support', async () => {
  await orm.em.fork().insert(TestEntity, {
    id: 1,
    value: 'wrong',
  })
  await wrapTsFpDiMikroorm(orm, async () => {
    const ref = em().getReference(TestEntity, 1)
    ref.value = 'test'
    $ref(ref)
  })

  const persisted = await orm.em.fork().findOne(TestEntity, { id: 1 })
  assert.strictEqual(persisted?.id, 1)
  assert.strictEqual(persisted?.value, 'test')
})

test('upsert support as update', async () => {
  await orm.em.fork().insert(TestEntity, {
    id: 1,
    value: 'wrong',
  })
  await wrapTsFpDiMikroorm(orm, async () => {
    const entity = new TestEntity({ id: 1, value: 'test', $forUpsert: true })
    $const(entity)
  })

  const persisted = await orm.em.fork().findOne(TestEntity, { id: 1 })
  assert.strictEqual(persisted?.id, 1)
  assert.strictEqual(persisted?.value, 'test')
})

test('upsert support as insert', async () => {
  await wrapTsFpDiMikroorm(orm, async () => {
    const entity = new TestEntity({ id: 1, value: 'test', $forUpsert: true })
    $const(entity)
  })

  const persisted = await orm.em.fork().findOne(TestEntity, { id: 1 })
  assert.strictEqual(persisted?.id, 1)
  assert.strictEqual(persisted?.value, 'test')
})
