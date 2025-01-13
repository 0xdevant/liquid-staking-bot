import { ApiPromise, Keyring, WsProvider } from '@polkadot/api'
import { KeyringPair } from '@polkadot/keyring/types'
import { BN } from '@polkadot/util'
import {
  cryptoWaitReady,
  decodeAddress,
  ethereumEncode,
  evmToAddress,
} from '@polkadot/util-crypto'
import * as ss58 from '@subsquid/ss58'
import assert from 'assert'
import axios, { AxiosResponse } from 'axios'
import fs from 'fs'
import path from 'path'
import { BigNumber, ethers } from 'ethers'
import * as pg from 'pg'
import ERC20ABI from './abis/ERC20.json'
import LiquidStakingABI from './abis/LiquidStaking.json'
import XCMABI from './abis/XCM.json'

const initSql = fs.readFileSync('init.sql').toString()

const ETHERS_JSON_RPC_PROVIDER =
  process.env.ETHERS_JSON_RPC_PROVIDER ?? 'https://evm.astar.network'
const ASTAR_WS_PROVIDER =
  process.env.ASTAR_WS_PROVIDER ?? 'wss://rpc.astar.network'
// const POLKADOT_WS_PROVIDER =
//   process.env.POLKADOT_WS_PROVIDER ?? 'wss://rpc.polkadot.io'
const POLKADOT_WS_PROVIDER =
  process.env.POLKADOT_WS_PROVIDER ??
  'wss://polkadot.api.onfinality.io/public-ws'

const XCM_CONTRACT_ADDRESS = '0x0000000000000000000000000000000000005004'

const LIQUID_STAKING_CONTRACT_ADDRESS =
  process.env.LIQUID_STAKING_CONTRACT_ADDRESS
const LIQUID_STAKING_SUBGRAPH_URL = process.env.LIQUID_STAKING_SUBGRAPH_URL

const DOT_ADDRESS =
  process.env.DOT_ADDRESS ?? '0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF'

const DRY_RUN_MODE = Boolean(JSON.parse(process.env.DRY_RUN_MODE ?? 'false'))

const SDOT_ADDRESS =
  process.env.SDOT_ADDRESS ?? '0xffffffff00000000000000000000000000000534'

const WASTR_ADDRESS =
  process.env.WASTR_ADDRESS ?? '0xEa093b81ca103585FC8Df82CB3D5D7F2e394AB70'

const ASTAR_PARACHAIN_ID = parseInt(process.env.ASTAR_PARACHAIN_ID ?? '2006')
const ASTAR_ADDRESS_PREFIX = 5
const DOT_DECIMALS = 10
const MIN_DOT_ON_POLKADOT = BigNumber.from(1.1 * 10 ** DOT_DECIMALS)
const CLAIM_REWARD_MIN_THRESHOLD = BigNumber.from(0.03 * 10 ** DOT_DECIMALS)
const DOT_TRANSACTION_FEE = BigNumber.from(350_000_000) //0.035 dot
const CLAIM_REWARD_AND_STAKE_MIN_THRESHOLD = DOT_TRANSACTION_FEE.mul(BigNumber.from(2))

const TX_SLEEP_MS = parseInt(process.env.TX_SLEEP_MS ?? '10000')
const PG_CONNECTION_TIMEOUT_MS = parseInt(
  process.env.PG_CONNECTION_TIMEOUT_MS ?? '10000'
)

const OPERATOR_SR25519_MNEMONIC = process.env.OPERATOR_SR25519_MNEMONIC
const OPERATOR_REWARD_SR25519_MNEMONIC =
  process.env.OPERATOR_REWARD_SR25519_MNEMONIC
const OPERATOR_EVM_PRIVATE_KEY = process.env.OPERATOR_EVM_PRIVATE_KEY
const DATABASE_URL = process.env.DATABASE_URL

// type TxOptions = {
//   gasLimit?: string | BigNumber
//   gasPrice?: string | BigNumber
//   value?: BigNumber
// }

// async function getGasPrice(): Promise<string | undefined> {
//   const astarGasStation: string =
//     'https://gas.astar.network/api/gasnow?network=astar'

//   const response: AxiosResponse<any, any> = await axios.get(astarGasStation)
//   const gasInfo = await response.data

//   return gasInfo?.data?.fast
// }

assert(LIQUID_STAKING_CONTRACT_ADDRESS)
assert(LIQUID_STAKING_SUBGRAPH_URL)
assert(OPERATOR_SR25519_MNEMONIC)
assert(OPERATOR_REWARD_SR25519_MNEMONIC)
assert(OPERATOR_EVM_PRIVATE_KEY)
assert(DATABASE_URL)
assert(DATABASE_URL.startsWith('postgresql://'))

function getAsserted<T>(x: T): NonNullable<T> {
  assert(x)
  return x
}

export class LiquidStakingBot {
  readonly substrateWallet!: KeyringPair
  readonly rewardSubstrateWallet!: KeyringPair
  readonly evmWallet!: ethers.Wallet

  readonly evm!: ethers.providers.Provider
  readonly polkadot!: ApiPromise
  readonly astar!: ApiPromise

  readonly liquidStakingContract!: ethers.Contract
  readonly dotContract!: ethers.Contract
  readonly sdotContract!: ethers.Contract
  readonly wastrContract!: ethers.Contract
  readonly xcmContract!: ethers.Contract

  readonly inited: boolean = false
  readonly txSleepMs = TX_SLEEP_MS

  async init(): Promise<void> {
    assert(!this.inited)
    await cryptoWaitReady()

    type Mutable<T> = { -readonly [K in keyof T]: T[K] }
    const that = this as Mutable<LiquidStakingBot>

    that.substrateWallet = new Keyring({ type: 'sr25519' }).addFromMnemonic(
      getAsserted(OPERATOR_SR25519_MNEMONIC)
    )
    that.rewardSubstrateWallet = new Keyring({
      type: 'sr25519',
    }).addFromMnemonic(getAsserted(OPERATOR_REWARD_SR25519_MNEMONIC))

    that.polkadot = await ApiPromise.create({
      provider: new WsProvider(POLKADOT_WS_PROVIDER),
    })
    that.astar = await ApiPromise.create({
      provider: new WsProvider(ASTAR_WS_PROVIDER),
    })
    that.evm = new ethers.providers.JsonRpcProvider(
      getAsserted(ETHERS_JSON_RPC_PROVIDER)
    )

    that.evmWallet = new ethers.Wallet(
      getAsserted(OPERATOR_EVM_PRIVATE_KEY),
      this.evm
    )

    that.liquidStakingContract = new ethers.Contract(
      getAsserted(LIQUID_STAKING_CONTRACT_ADDRESS),
      LiquidStakingABI,
      this.evmWallet
    )

    that.dotContract = new ethers.Contract(
      getAsserted(DOT_ADDRESS),
      ERC20ABI,
      this.evmWallet
    )

    that.sdotContract = new ethers.Contract(
      getAsserted(SDOT_ADDRESS),
      ERC20ABI,
      this.evmWallet
    )

    that.wastrContract = new ethers.Contract(
      getAsserted(WASTR_ADDRESS),
      ERC20ABI,
      this.evmWallet
    )

    that.xcmContract = new ethers.Contract(
      XCM_CONTRACT_ADDRESS,
      XCMABI,
      this.evmWallet
    )

    const pgClient = new pg.Client({
      connectionString: getAsserted(DATABASE_URL),
      connectionTimeoutMillis: PG_CONNECTION_TIMEOUT_MS,
    })
    await pgClient.connect()
    try {
      await pgClient.query('SELECT EXISTS (SELECT 1 FROM unstake_requests)')
    } catch (error) {
      await pgClient.query(initSql)
    }
    await pgClient.end()
    // const isExist = await pgClient.query(
    //   `SELECT EXISTS (SELECT 1 FROM unstake_requests)`
    // )
    // if (!isExist) {
    //   await pgClient.query(initSql)
    // }
    await pgClient.end()
    that.inited = true
  }

  async sleepAfterTx(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.txSleepMs))
  }

  async reportAstarEvmBalance(
    address: string,
    tokenContract?: ethers.Contract
  ): Promise<void> {
    if (tokenContract != null) {
      console.info(
        `    balanceOf(${address}): ${await tokenContract.balanceOf(
          address
        )} AstarEVM ${await tokenContract.symbol()}`
      )
    } else {
      console.info(
        `    balanceOf(${address}): ${await this.evm.getBalance(
          address
        )} AstarEVM ASTR`
      )
    }
  }

  async reportAstarBalance(wallet: KeyringPair): Promise<void> {
    const addr = ss58.codec('astar').encode(wallet.publicKey)
    const acct: any = (await this.astar.query.system.account(addr)).toJSON()
    console.info(
      `    balanceOf(${addr}): ${BigNumber.from(acct.data.free)} Astar ASTR`
    )
  }

  async reportPolkadotBalance(wallet: KeyringPair): Promise<void> {
    const addr = ss58.codec('polkadot').encode(wallet.publicKey)
    const acct: any = (await this.polkadot.query.system.account(addr)).toJSON()
    console.info(
      `    balanceOf(${addr}): ${BigNumber.from(acct.data.free)} Polkadot DOT`
    )
  }

  async reportAllBalances(): Promise<void> {
    console.log('Balances:')
    await this.reportAstarEvmBalance(this.evmWallet.address)
    await this.reportAstarEvmBalance(this.evmWallet.address, this.dotContract)
    await this.reportAstarEvmBalance(this.evmWallet.address, this.sdotContract)
    await this.reportAstarBalance(this.substrateWallet)
    await this.reportPolkadotBalance(this.substrateWallet)
  }

  async withdrawPayout(): Promise<BigNumber> {
    console.info('> withdrawPayout')

    await this.reportAllBalances()

    const polkadotBalanceBeforeClaim = await this.getPolkadotDotFreeBalance()

    let pendingRewards = (
      await this.polkadot.call.nominationPoolsApi.pendingRewards(
        this.substrateWallet.publicKey
      )
    ).toJSON() as any
    
    pendingRewards = BigNumber.from(pendingRewards)

    // only claimPayout() when there are enough rewards to cover gas fee and gt min stake amount
    if (pendingRewards.gt(CLAIM_REWARD_AND_STAKE_MIN_THRESHOLD)) {
      const tx = await this.polkadot.tx.nominationPools
        .claimPayout()
        .signAndSend(this.substrateWallet)
      console.log('withdrawPayout()', tx.toHex())
      await this.sleepAfterTx()
    }

    const polkadotBalanceAfterClaim = await this.getPolkadotDotFreeBalance()

    let claimReward = BigNumber.from(0);

    if (polkadotBalanceAfterClaim.sub(polkadotBalanceBeforeClaim).gt(BigNumber.from(0)) &&
     polkadotBalanceAfterClaim.sub(polkadotBalanceBeforeClaim).lte(pendingRewards)
    ) {
      claimReward = pendingRewards
    }

    const totalSupply = BigNumber.from(await this.sdotContract.totalSupply())
    const pgClient = new pg.Client({
      connectionString: getAsserted(DATABASE_URL),
      connectionTimeoutMillis: PG_CONNECTION_TIMEOUT_MS,
    })
    try {
      await pgClient.connect()
      await pgClient.query('begin')
      await pgClient.query(
        'insert into payout_records("timestamp", total_payout_amount, total_bonded_amount) values ($1, $2, $3)',
        [new Date(), claimReward.toString(), totalSupply.toString()]
      )
      await pgClient.query('commit')
    } catch {
      await pgClient.query('rollback')
    } finally {
      await pgClient.end()
    }

    if (claimReward.isZero()) {
      return claimReward
    }

    await this.transferDotFromPolkadotToAstarEvm(claimReward)

    return claimReward
  }

  async stakeRewards(
    amount: BigNumber
  ): Promise<ethers.providers.TransactionResponse | undefined> {
    console.info(`> stakeRewards(${amount})`)

    if (amount.isZero()) {
      return undefined
    }

    await this.reportAllBalances()

    const tx = await this.liquidStakingContract.stake(amount, {
      gasLimit: BigNumber.from(8_000_000),
    })

    await tx.wait()
    console.log(tx)

    await this.reportAllBalances()

    return tx
  }

  async distributeRewardSdot(amount: BigNumber): Promise<void> {
    console.info(`> distributeRewardSdot(${amount})`)

    if (amount.isZero()) {
      return
    }

    //stakeRewards has fee
    amount = amount.sub(DOT_TRANSACTION_FEE)

    const resp = await axios.post(getAsserted(LIQUID_STAKING_SUBGRAPH_URL), {
      query: '{ users { id balance } }',
    })

    if ('errors' in resp.data) {
      console.error(resp.data.errors)
      return
    }

    const totalBalance = resp.data.data.users.reduce(
      (acc: BigNumber, user: { balance: string }) => {
        const x = BigNumber.from(user.balance)
        return x.isNegative() ? acc : acc.add(x)
      },
      BigNumber.from(0)
    )

    const xs: Array<[string, BigNumber]> = []

    for (const user of resp.data.data.users) {
      const b = BigNumber.from(user.balance)
      if (b.isZero()) {
        continue
      }
      const amount1 = amount.mul(b).div(totalBalance)
      if (amount1.gt(0)) {
        console.log(`Will transfer ${amount1} SDOT to ${user.id}`)
        xs.push([user.id, amount1])
      }
    }

    if (!DRY_RUN_MODE) {
      for (const [id, amount] of xs) {
        console.log(`Transferring ${amount} SDOT to ${id}`)
        const tx: ethers.providers.TransactionResponse =
          this.sdotContract.transfer(id, amount)
          
        await tx
        
        console.log(`Transferred ${amount} SDOT to ${id}`, tx)
      }
    }
  }

  async withdrawStakedDotToRelay(): Promise<BigNumber> {
    console.info('> withdrawStakedDotToRelay()')

    const contractOperatorAddress = await this.liquidStakingContract.operator()
    assert(
      contractOperatorAddress.toLowerCase() ===
        this.evmWallet.address.toLowerCase()
    )

    const totalPendingBondAmount: BigNumber =
      await this.liquidStakingContract.totalPendingBondAmount()
    if (totalPendingBondAmount.isZero()) {
      console.log('No pending bond')
      return BigNumber.from(0)
    }

    console.info('Start withdrawing pending bond from contract...')
    await this.reportAllBalances()

    console.info('Withdraw pending bond tx')

    const tx1 = await this.liquidStakingContract.withdrawPendingBond()

    console.log(tx1.hash)
    await tx1.wait()
    await this.reportAllBalances()

    // const amountToBond = await this.dotContract.balanceOf(
    //   this.evmWallet.address
    // )
    const amountToBond = totalPendingBondAmount

    console.log('Send DOT to relay chain...')
    await this.reportAllBalances()

    const tx2: ethers.providers.TransactionResponse =
      await this.xcmContract.assets_withdraw(
        [getAsserted(DOT_ADDRESS).toLowerCase()],
        [amountToBond],
        this.substrateWallet.addressRaw,
        // ethereumEncode(this.substrateWallet.publicKey),
        true,
        0,
        0
      )
    console.log(tx2.hash)
    await tx2.wait()
    await this.reportAllBalances()

    return totalPendingBondAmount
  }

  async bondExtraToNominator(amountToBond?: BigNumber): Promise<void> {
    console.info(`> bondExtraToNominator(${amountToBond?.toString()})`)

    if (amountToBond?.isZero() ?? false) {
      return
    }

    await this.reportAllBalances()

    // const tx = await this.polkadot.tx.staking
    //   .bondExtra(amountToBond ?? (await this.getPolkadotDotFreeBalance()))
    //   .signAndSend(this.substrateWallet)

    const tx = await this.polkadot.tx.nominationPools
      .bondExtra({
        FreeBalance: amountToBond,
      })
      .signAndSend(this.substrateWallet)
    console.log('bondExtraToNominator()', tx.toHex())
    await this.sleepAfterTx()

    await this.reportAllBalances()
  }

  async submitUnstakeRequests(): Promise<void> {
    console.info('> submitUnstakeRequests()')

    const resp = await axios.post(getAsserted(LIQUID_STAKING_SUBGRAPH_URL), {
      query:
        '{ unstakeTimeSlots { id timestamp amount unstakes { id user amount } } }',
    })
    const pgClient = new pg.Client({
      connectionString: getAsserted(DATABASE_URL),
      connectionTimeoutMillis: PG_CONNECTION_TIMEOUT_MS,
    })
    try {
      await pgClient.connect()
      const processedTimeSlots = new Set(
        (
          await pgClient.query('select "timestamp" from processed_time_slots')
        ).rows.map((x) => +x.timestamp / 1000)
      )
      let amountToUnbond = BigNumber.from(0)
      await pgClient.query('begin')
      for (const timeslot of resp.data.data.unstakeTimeSlots) {
        if (processedTimeSlots.has(+timeslot.timestamp)) {
          continue
        }

        console.log(`Processing timeslot ${timeslot.id}...`)

        await pgClient.query(
          'insert into processed_time_slots(id, "timestamp") values ($1, $2)',
          [timeslot.id, new Date(+timeslot.timestamp * 1000)]
        )
        amountToUnbond = amountToUnbond.add(timeslot.amount)

        for (const req of timeslot.unstakes) {
          await pgClient.query(
            'insert into unstake_requests(unstake_id, "timestamp", "user", amount) values ($1, $2, $3, $4)',
            [req.id, new Date(+timeslot.timestamp * 1000), req.user, req.amount]
          )
        }
      }

      if (amountToUnbond.gt(0)) {
        await this.reportAllBalances()
        const tx = await this.polkadot.tx.nominationPools
          .unbond(this.substrateWallet.address, amountToUnbond.toString())
          .signAndSend(this.substrateWallet)
        console.log('submitUnstakeRequests()', tx.toHex())
        await this.sleepAfterTx()
        await this.reportAllBalances()
      }

      await pgClient.query('commit')
    } catch {
      await pgClient.query('rollback')
    } finally {
      await pgClient.end()
    }
  }

  async withdrawUnbondedDot(): Promise<BigNumber> {
    console.info('> withdrawUnbondedDot()')

    // only for checking unlocked amount in staking
    // const ledger = (
    //   await this.polkadot.query.staking.ledger(this.substrateWallet.publicKey)
    // ).toJSON() as any

    // const unlocked = BigNumber.from(ledger.total)
    //   .sub(ledger.active)
    //   .sub(
    //     ledger.unlocking.reduce(
    //       (a: BigNumber, x: any) => a.add(x.value),
    //       BigNumber.from(0)
    //     )
    //   )

    const ownNominationPoolInfo = (
      await this.polkadot.query.nominationPools.poolMembers(
        this.substrateWallet.publicKey
      )
    ).toJSON() as any

    const currentEra = (
      await this.polkadot.query.staking.activeEra()
    ).toJSON() as any

    // if (unlocked.lte(0)) {
    //   console.info('No DOT unlocked, skipping...')
    //   return BigNumber.from(0)
    // }

    let unlocked = BigNumber.from(0)
    for (const era in ownNominationPoolInfo.unbondingEras) {
      // unbonding DOT unlocked
      if (currentEra.index >= era) {
        unlocked = unlocked.add(
          BigNumber.from(ownNominationPoolInfo.unbondingEras[era])
        )
      }
    }
    console.log(`unlocked: ${unlocked}`)

    if (
      Object.keys(ownNominationPoolInfo.unbondingEras).length === 0 ||
      unlocked.lte(0)
    ) {
      console.info('No DOT unlocked, skipping...')
      return BigNumber.from(0)
    }

    console.info(`Withdrawing unlocked DOT: ${unlocked.toString()}`)

    await this.reportAllBalances()

    const bal1 = await this.getPolkadotDotFreeBalance()

    const tx = await this.polkadot.tx.nominationPools
      .withdrawUnbonded(this.substrateWallet.address, 0)
      .signAndSend(this.substrateWallet)
    console.log('withdrawUnbondedDot()', tx.toHex())
    await this.sleepAfterTx()

    await this.reportAllBalances()

    const bal2 = await this.getPolkadotDotFreeBalance()

    // console.info('Withdrew DOT:', bal2.sub(bal1).toString())
    console.info('Withdrew DOT:', unlocked.toString())

    if (bal2.gt(bal1)) {
      // const amount = bal2.sub(bal1)
      const amount = unlocked
      await this.transferDotFromPolkadotToAstarEvm(amount)
      return amount
    }

    return BigNumber.from(0)
  }

  async getPolkadotDotFreeBalance(addr?: string): Promise<BigNumber> {
    const balanceData: any = (
      await this.polkadot.query.system.account(
        addr ?? this.substrateWallet.address
      )
    ).toJSON()

    // data.free =/= freeBalance because unbonding DOTs still count towards data.free
    // miscFrozen is included in free, free must be > miscFrozen
    const freeBalance = BigNumber.from(balanceData.data.free).sub(
      BigNumber.from(balanceData.data.miscFrozen)
    )
    // ensure freeBalance will only be used when > MIN_DOT_ON_POLKADOT
    return freeBalance.sub(MIN_DOT_ON_POLKADOT).gt(0)
      ? freeBalance.sub(MIN_DOT_ON_POLKADOT)
      : BigNumber.from(0)
  }

  async transferDotFromPolkadotToAstarEvm(amount?: BigNumber): Promise<void> {
    console.log(`transferDotFromPolkadotToAstarEvm(${amount})...`)
    await this.reportAllBalances()

    const tx = await (this.polkadot.tx as any).xcmPallet
      .reserveTransferAssets(
        {
          V1: {
            parents: new BN(0),
            interior: { X1: { Parachain: new BN(ASTAR_PARACHAIN_ID) } },
          },
        },
        {
          V1: {
            parents: new BN(0),
            interior: {
              X1: {
                AccountId32: {
                  network: 'Any',
                  id: decodeAddress(
                    evmToAddress(this.evmWallet.address, ASTAR_ADDRESS_PREFIX)
                  ),
                },
              },
            },
          },
        },
        {
          V1: [
            {
              id: { Concrete: { parents: 0, interior: 'Here' } },
              fun: {
                Fungible: new BN(
                  amount?.toString() ??
                    (await this.getPolkadotDotFreeBalance()).toString()
                ),
              },
            },
          ],
        },
        0
      )
      .signAndSend(this.substrateWallet)

    console.log('transferDotFromPolkadotToAstarEvm()', tx.toHex())
    await this.sleepAfterTx()

    await this.reportAllBalances()
  }

  async distributedUnbondedDot(amountToDistribute: BigNumber): Promise<void> {
    console.info(`> distributedUnbondedDot(${amountToDistribute})`)

    if (amountToDistribute.isZero()) {
      return
    }

    let freeBalance = BigNumber.from(
      await this.dotContract.balanceOf(this.evmWallet.address)
    )
    assert(freeBalance.gte(amountToDistribute))

    const tx0 = await this.dotContract.approve(
      this.liquidStakingContract.address,
      amountToDistribute
    )
    console.log(tx0.hash)
    await tx0.wait()
    await this.sleepAfterTx()

    const pgClient = new pg.Client({
      connectionString: getAsserted(DATABASE_URL),
      connectionTimeoutMillis: PG_CONNECTION_TIMEOUT_MS,
    })
    try {
      await pgClient.connect()
      const unstakeRequests = (
        await pgClient.query(
          'select * from unstake_requests where not processed order by id asc'
        )
      ).rows
      for (const x of unstakeRequests) {
        let amount = BigNumber.from(x.amount)

        /* should process one by one, not getting the total of pendingUnbondAmount directly from contract */
        // const [, pendingUnbondAmount] =
        //   await this.liquidStakingContract.getUserInfo(
        //     /*x.id,
        //     this.sdotContract.address*/
        //     x.user,
        //     this.wastrContract.address
        //   )

        // if (BigNumber.from(pendingUnbondAmount).lt(amount)) {
        //   amount = BigNumber.from(pendingUnbondAmount)
        // }

        if (amount.gt(freeBalance)) {
          console.log(`Insufficient balance to process unstake request ${x.id}`)
          break
        }

        console.log(`Processing unstake request ${x.unstake_id}...`)
        await pgClient.query(
          'update unstake_requests set processed = true where unstake_id = $1',
          [x.unstake_id]
        )
        try {
          if (DRY_RUN_MODE) {
            await pgClient.query(
              'update unstake_requests set processed = false where unstake_id = $1',
              [x.unstake_id]
            )
          } else {
            const tx = this.liquidStakingContract.depositUnbonded(
              x.user,
              amount
            )
            console.log(tx)
          }

          freeBalance = freeBalance.sub(amount)
        } catch (e) {
          console.error(e)
          await pgClient.query(
            'update unstake_requests set processed = false where unstake_id = $1',
            [x.unstake_id]
          )
          throw e
        }
      }
    } finally {
      await pgClient.end()
    }
  }

  async tick(): Promise<void> {
    assert(this.inited)

    const payoutWithdrawn = await this.withdrawPayout()
    await this.stakeRewards(payoutWithdrawn)
    await this.distributeRewardSdot(payoutWithdrawn)

    const dotWithdrawnAmount = await this.withdrawUnbondedDot()
    await this.distributedUnbondedDot(dotWithdrawnAmount)

    const amountToBond = await this.withdrawStakedDotToRelay()
    await this.bondExtraToNominator(amountToBond)

    await this.submitUnstakeRequests()
  }
}

async function main(): Promise<void> {
  const bot = new LiquidStakingBot()
  await bot.init()
  await bot.tick()

  console.info('> Finished!')

  process.exit(0)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}