import { Entity, EventArgs, EventSubscriber, MikroORM, PrimaryKey, Property, wrap } from '@mikro-orm/core'
import { defineConfig } from '@mikro-orm/better-sqlite'
import test, { afterEach, beforeEach } from 'node:test'
import { em, entityConstructor, onPersist, wrapTsFpDiMikroorm } from './index'
import assert from 'node:assert'
import { dic, dis } from 'ts-fp-di'

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

  $forDelete?: boolean
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

const $storeMultiple = dis(
  (state: TestEntity[], payload: Partial<TestEntity>) => state.concat(new TestEntity(payload)),
  []
)

const $const = dic<TestEntity>()

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

test('persistance works for $store (multiple entities)', async () => {
  await wrapTsFpDiMikroorm(orm, async () => {
    $storeMultiple({ value: 'test' })
    $storeMultiple({ value: 'test2' })
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
      assert.deepStrictEqual($store(), new TestEntity({ id: 1, value: 'test', version: 1 }))
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
