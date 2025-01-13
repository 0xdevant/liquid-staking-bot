import assert from 'assert'
import Koa from 'koa'
import json from 'koa-json'
import LRU from 'lru-cache'
import * as pg from 'pg'

const DATABASE_URL = process.env.DATABASE_URL
const PORT = parseInt(process.env.PORT ?? '3000')
const PG_CONNECTION_TIMEOUT_MS = parseInt(
  process.env.PG_CONNECTION_TIMEOUT_MS ?? '10000'
)
const CACHE_TTL = parseInt(process.env.CACHE_TTL ?? '60000')

async function main(): Promise<void> {
  const app = new Koa()
  const cache = new LRU({ max: 1000, ttl: CACHE_TTL })
  assert(DATABASE_URL)

  app.use(json())
  app.use(async(ctx) => {
    const interval: string =
      ctx.query.interval != null ? `${ctx.query.interval}` : '7 days'
    assert(interval.match(/[^0-9a-z ]/) == null)
    const cacheKey = `apy_${interval}`
    const apy = cache.get(cacheKey)

    if (apy !== undefined) {
      ctx.body = { apy }
      return
    }

    const pgClient = new pg.Client({
      connectionString: DATABASE_URL,
      connectionTimeoutMillis: PG_CONNECTION_TIMEOUT_MS
    })
    try {
      await pgClient.connect()
      const { rows } = await pgClient.query(
        `select sum(total_payout_amount) / avg(total_bonded_amount) * (extract(epoch from interval '365 days') / extract(epoch from interval '${interval}')) as apy from payout_records where "timestamp" > now() - interval '${interval}'`
      )
      assert(rows.length === 1)
      cache.set(cacheKey, rows[0].apy)
      ctx.body = { apy: rows[0].apy }
    } finally {
      await pgClient.end()
    }
  })
  app.listen(PORT)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
