# ts-fp-di-mikroorm

Use MikroORM Entities inside ts-fp-di State and achieve auto persistence in DB

## Knowledge requirements

Basic knowledge of [ts-fp-di](https://github.com/darky/ts-fp-di/) and [MikroORM](https://mikro-orm.io/)

## Get started

Firstly, need to wrap each life cycle of your backend application (each HTTP request/response, handle MQ message, ...) with **ts-fp-di-mikroorm**<br/>
Example of middleware for typical Koa application, where each HTTP request will be wrapped:

```ts
const orm = await MikroORM.init(
  defineConfig({
    /* DB config */
    entities: [
      /* init MikroORM Entities */
    ],
  })
)

app.use(async (ctx, next) => {
  await wrapTsFpDiMikroorm(orm, async () => {
    return await next()
  })
})
```

Further, simply use ts-fp-di and MikroORM "as is" in code and auto persistence in DB will "magically" works 🪄 <br/>
Only need to use `em` helper for MikroORM, which can help to consider context of appropriate life cycle

## Example

```ts
import { Entity, PrimaryKey, Property, wrap } from '@mikro-orm/core'
import { em, entityConstructor, onPersist, wrapTsFpDiMikroorm } from 'ts-fp-di-mikroorm'
import { dis } from 'ts-fp-di'

@Entity()
class UserEntity {
  constructor(entity: Partial<UserEntity>) {
    // just little sugar, for avoiding boilerplate this.key = value
    entityConstructor(this, entity)
  }

  @PrimaryKey()
  id!: number

  @Property()
  name!: string

  // service property for deleting Entity, see below
  $forDelete?: boolean
}

const fetchUser = async (id: number) => {
  // `em()` will return MikroORM Entity Manager for appropriate life cycle
  // need use `em()` everywhere, when you want to use MikroORM API
  return em().findOne(UserEntity, { id })
}

// diOnce, dic, diMap also supported
const $user = dis<UserEntity | null>((state, payload) =>
  state ? wrap(state).assign(payload) : payload instanceof UserEntity ? payload : new UserEntity(payload)
)

// `wrapTsFpDiMikroorm` here just for example
// Need to use `wrapTsFpDiMikroorm` as middleware of your framework, see example above
await wrapTsFpDiMikroorm(orm, async () => {
  // Mutate $user State for futher mutation
  $user({ name: 'Vasya' })
  // Optional hook, which will be called after DB persist
  onPersist(async () => {
    $user() // BTW, $user already contains `id`, because it's already persisted in DB
  })
})

// By the way, user Vasya already persisted in DB!

await wrapTsFpDiMikroorm(orm, async () => {
  $user(await fetchUser(1))
  $user({ name: 'Petya' })
})

// user Vasya realized that he is Petya in DB now

await wrapTsFpDiMikroorm(orm, async () => {
  $user(await fetchUser(1))
  $user({ $noPersist: true })
})

// Persistance to DB ignored

await wrapTsFpDiMikroorm(orm, async () => {
  $user(await fetchUser(1))
  $user({ $forDelete: true })
})

// user Petya go away from DB
```
