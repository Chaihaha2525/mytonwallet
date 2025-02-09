import type { JettonBalance } from 'tonapi-sdk-js';
import { Address, Cell } from '@ton/core';

import type { ApiNetwork, ApiToken } from '../../types';
import type {
  AnyPayload, ApiTransactionExtra, JettonMetadata, TonTransferParams,
} from './types';

import { TON_USDT_SLUG } from '../../../config';
import { parseAccountId } from '../../../util/account';
import { fetchJsonWithProxy } from '../../../util/fetch';
import { logDebugError } from '../../../util/logs';
import { fixIpfsUrl } from '../../../util/metadata';
import {
  fetchJettonMetadata,
  fixBase64ImageData,
  parseJettonWalletMsgBody,
  parsePayloadBase64,
} from './util/metadata';
import { fetchJettonBalances } from './util/tonapiio';
import {
  buildTokenTransferBody,
  getTonClient,
  resolveTokenAddress,
  resolveTokenWalletAddress,
  toBase64Address, toRawAddress,
} from './util/tonCore';
import { JettonWallet } from './contracts/JettonWallet';
import { fetchStoredTonWallet } from '../../common/accounts';
import { buildTokenSlug, getTokenByAddress } from '../../common/tokens';
import {
  CLAIM_MINTLESS_AMOUNT,
  DEFAULT_DECIMALS,
  TINIEST_TOKEN_REAL_TRANSFER_AMOUNT,
  TINY_TOKEN_REAL_TRANSFER_AMOUNT,
  TINY_TOKEN_TRANSFER_AMOUNT,
  TOKEN_REAL_TRANSFER_AMOUNT,
  TOKEN_TRANSFER_AMOUNT,
  TOKEN_TRANSFER_FORWARD_AMOUNT,
} from './constants';
import { isActiveSmartContract } from './wallet';

export type TokenBalanceParsed = {
  slug: string;
  balance: bigint;
  token: ApiToken;
  jettonWallet: string;
};

export async function getAccountTokenBalances(accountId: string) {
  const { network } = parseAccountId(accountId);
  const { address } = await fetchStoredTonWallet(accountId);

  return getTokenBalances(network, address);
}

export async function getTokenBalances(network: ApiNetwork, address: string) {
  const balancesRaw = await fetchJettonBalances(network, address);
  return balancesRaw.map((balance) => parseTokenBalance(network, balance)).filter(Boolean);
}

export async function getAddressTokenBalances(address: string, network: ApiNetwork) {
  const balancesRaw = await fetchJettonBalances(network, address);
  return balancesRaw.map((balance) => parseTokenBalance(network, balance)).filter(Boolean);
}

function parseTokenBalance(network: ApiNetwork, balanceRaw: JettonBalance): TokenBalanceParsed | undefined {
  if (!balanceRaw.jetton) {
    return undefined;
  }

  try {
    const { balance, jetton, wallet_address: walletAddress } = balanceRaw;
    const tokenAddress = toBase64Address(jetton.address, true, network);
    const token = buildTokenByMetadata(tokenAddress, jetton);

    return {
      slug: token.slug,
      balance: BigInt(balance),
      token,
      jettonWallet: toBase64Address(walletAddress.address, undefined, network),
    };
  } catch (err) {
    logDebugError('parseTokenBalance', err);
    return undefined;
  }
}

export function parseTokenTransaction(
  network: ApiNetwork,
  tx: ApiTransactionExtra,
  slug: string,
  walletAddress: string,
): ApiTransactionExtra | undefined {
  const { extraData } = tx;
  if (!extraData?.body) {
    return undefined;
  }

  const parsedData = parseJettonWalletMsgBody(network, extraData.body);
  if (!parsedData) {
    return undefined;
  }

  const {
    operation,
    jettonAmount,
    address,
    comment,
    encryptedComment,
    type,
  } = parsedData;
  const isIncoming = operation === 'InternalTransfer';

  const fromAddress = isIncoming ? (address ?? tx.fromAddress) : walletAddress;
  const toAddress = isIncoming ? walletAddress : address!;
  const normalizedAddress = toBase64Address(isIncoming ? fromAddress : toAddress, true);

  return {
    ...tx,
    type,
    slug,
    fromAddress,
    toAddress,
    normalizedAddress,
    amount: isIncoming ? jettonAmount : -jettonAmount,
    comment,
    encryptedComment,
    isIncoming,
  };
}

export async function insertMintlessPayload(
  network: ApiNetwork,
  fromAddress: string,
  tokenAddress: string,
  transfer: TonTransferParams,
): Promise<TonTransferParams> {
  const { toAddress, payload } = transfer;

  const token = getTokenByAddress(tokenAddress);
  if (typeof payload !== 'string' || !token?.customPayloadApiUrl) {
    return transfer;
  }

  const parsedPayload = await parsePayloadBase64(network, toAddress, payload);
  if (parsedPayload.type !== 'tokens:transfer') {
    throw new Error('Invalid payload');
  }

  const {
    mintlessTokenBalance,
    isMintlessClaimed,
    stateInit,
    customPayload,
  } = await getMintlessParams({
    network,
    token,
    fromAddress,
    tokenWalletAddress: transfer.toAddress,
  });

  if (!mintlessTokenBalance || isMintlessClaimed) {
    return transfer;
  }

  const newPayload = buildTokenTransferBody({
    toAddress: parsedPayload.destination,
    queryId: parsedPayload.queryId,
    tokenAmount: parsedPayload.amount,
    forwardAmount: parsedPayload.forwardAmount,
    forwardPayload: Cell.fromBase64(parsedPayload.forwardPayload!),
    responseAddress: parsedPayload.responseDestination,
    customPayload: Cell.fromBase64(customPayload!),
  });

  return {
    ...transfer,
    stateInit: stateInit ? Cell.fromBase64(stateInit) : undefined,
    payload: newPayload,
    isBase64Payload: false,
  };
}

export async function buildTokenTransfer(options: {
  network: ApiNetwork;
  tokenAddress: string;
  fromAddress: string;
  toAddress: string;
  amount: bigint;
  payload?: AnyPayload;
  shouldSkipMintless?: boolean;
  forwardAmount?: bigint;
}) {
  const {
    network,
    tokenAddress,
    fromAddress,
    toAddress,
    amount,
    shouldSkipMintless,
    forwardAmount = TOKEN_TRANSFER_FORWARD_AMOUNT,
  } = options;
  let { payload } = options;

  const tokenWalletAddress = await resolveTokenWalletAddress(network, fromAddress, tokenAddress);
  const tokenWallet = getTokenWallet(network, tokenWalletAddress);
  const token = getTokenByAddress(tokenAddress)!;

  const {
    isTokenWalletDeployed,
    isMintlessClaimed,
    mintlessTokenBalance,
    customPayload,
    stateInit,
  } = await getMintlessParams({
    network, fromAddress, token, tokenWalletAddress, shouldSkipMintless,
  });

  if (isTokenWalletDeployed) {
    const realTokenAddress = await resolveTokenAddress(network, tokenWalletAddress);
    if (tokenAddress !== realTokenAddress) {
      throw new Error('Invalid contract');
    }
  }

  payload = buildTokenTransferBody({
    tokenAmount: amount,
    toAddress,
    forwardAmount,
    forwardPayload: payload,
    responseAddress: fromAddress,
    customPayload: customPayload ? Cell.fromBase64(customPayload) : undefined,
  });

  // eslint-disable-next-line prefer-const
  let { amount: toncoinAmount, realAmount } = getToncoinAmountForTransfer(
    token, Boolean(mintlessTokenBalance) && !isMintlessClaimed,
  );

  if (forwardAmount > TOKEN_TRANSFER_FORWARD_AMOUNT) {
    toncoinAmount += forwardAmount;
  }

  return {
    amount: toncoinAmount,
    realAmount,
    tokenWallet,
    toAddress: tokenWalletAddress,
    payload,
    stateInit: stateInit ? Cell.fromBase64(stateInit) : undefined,
    mintlessTokenBalance,
    isTokenWalletDeployed,
  };
}

export async function getMintlessParams(options: {
  network: ApiNetwork;
  fromAddress: string;
  token: ApiToken;
  tokenWalletAddress: string;
  shouldSkipMintless?: boolean;
}) {
  const {
    network, fromAddress, token, tokenWalletAddress, shouldSkipMintless,
  } = options;

  const isMintlessToken = !!token.customPayloadApiUrl;
  const isTokenWalletDeployed = isMintlessToken
    ? !!(await isActiveSmartContract(network, tokenWalletAddress))
    // This value is incorrect when an uninitialized "from" token is selected in the swap form. This causes an error inside the `if (isTokenWalletDeployed)` condition body above.
    // todo: Try to check token wallet deployment in case of mintfull tokens too
    : true;
  let customPayload: string | undefined;
  let stateInit: string | undefined;

  let isMintlessClaimed: boolean | undefined;
  let mintlessTokenBalance: bigint | undefined;

  if (isMintlessToken && !shouldSkipMintless) {
    isMintlessClaimed = isTokenWalletDeployed && await checkMintlessTokenWalletIsClaimed(network, tokenWalletAddress);

    if (!isMintlessClaimed) {
      const data = await fetchMintlessTokenWalletData(token.customPayloadApiUrl!, fromAddress);
      const isExpired = data
        ? Date.now() > new Date(Number(data.compressed_info.expired_at) * 1000).getTime()
        : true;

      if (data && !isExpired) {
        customPayload = data.custom_payload;
        mintlessTokenBalance = BigInt(data.compressed_info.amount);

        if (!isTokenWalletDeployed) {
          stateInit = data.state_init;
        }
      }
    }
  }

  return {
    isTokenWalletDeployed,
    isMintlessClaimed,
    mintlessTokenBalance,
    customPayload,
    stateInit,
  };
}

export async function checkMintlessTokenWalletIsClaimed(network: ApiNetwork, tokenWalletAddress: string) {
  const res = await getTonClient(network)
    .runMethod(Address.parse(tokenWalletAddress), 'is_claimed');
  return res.stack.readBoolean();
}

async function fetchMintlessTokenWalletData(customPayloadApiUrl: string, address: string) {
  const rawAddress = toRawAddress(address);

  return (await fetchJsonWithProxy(`${customPayloadApiUrl}/wallet/${rawAddress}`).catch(() => undefined)) as {
    custom_payload: string;
    state_init: string;
    compressed_info: {
      amount: string;
      start_from: string;
      expired_at: string;
    };
  } | undefined;
}

export function getTokenWallet(network: ApiNetwork, tokenAddress: string) {
  return getTonClient(network).open(new JettonWallet(Address.parse(tokenAddress)));
}

export async function fetchToken(network: ApiNetwork, address: string) {
  const metadata = await fetchJettonMetadata(network, address);

  return buildTokenByMetadata(address, metadata);
}

function buildTokenByMetadata(address: string, metadata: JettonMetadata): ApiToken {
  const {
    name,
    symbol,
    image,
    image_data: imageData,
    decimals,
    custom_payload_api_uri: customPayloadApiUrl,
  } = metadata;

  return {
    slug: buildTokenSlug('ton', address),
    name,
    symbol,
    decimals: decimals === undefined ? DEFAULT_DECIMALS : Number(decimals),
    chain: 'ton',
    tokenAddress: address,
    image: (image && fixIpfsUrl(image)) || (imageData && fixBase64ImageData(imageData)) || undefined,
    customPayloadApiUrl,
  };
}

/**
 * A pure function guessing the "fee" that needs to be attached to the token transfer.
 * In contrast to the blockchain fee, this fee is a part of the transfer itself.
 *
 * `amount` is what should be attached (acts as a fee for the user);
 * `realAmount` is approximately what will be actually spent (the rest will return in the excess).
 */
export function getToncoinAmountForTransfer(token: ApiToken, willClaimMintless: boolean) {
  let amount = 0n;
  let realAmount = 0n;

  if (token.isTiny) {
    amount += TINY_TOKEN_TRANSFER_AMOUNT;

    if (token.slug === TON_USDT_SLUG) {
      realAmount += TINIEST_TOKEN_REAL_TRANSFER_AMOUNT;
    } else {
      realAmount += TINY_TOKEN_REAL_TRANSFER_AMOUNT;
    }
  } else {
    amount += TOKEN_TRANSFER_AMOUNT;
    realAmount += TOKEN_REAL_TRANSFER_AMOUNT;
  }

  if (willClaimMintless) {
    amount += CLAIM_MINTLESS_AMOUNT;
    realAmount += CLAIM_MINTLESS_AMOUNT;
  }

  return { amount, realAmount };
}
