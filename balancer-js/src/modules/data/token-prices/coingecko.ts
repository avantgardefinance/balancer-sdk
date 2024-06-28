/* eslint-disable @typescript-eslint/no-empty-function */
import { Price, Findable, TokenPrices, Network } from '@/types';
import axios from 'axios';
import { TOKENS } from '@/lib/constants/tokens';
import { Debouncer, tokenAddressForPricing } from '@/lib/utils';

function splitIntoChunks<TItem>(items: TItem[]): TItem[][] {
  const chunks: TItem[][] = [];
  const chunkSize = 10;
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Simple coingecko price source implementation. Configurable by network and token addresses.
 */
export class CoingeckoPriceRepository implements Findable<Price> {
  prices: { [key: string]: Promise<Price> } = {};
  nativePrice?: Promise<Price>;
  urlBase: string;
  baseTokenAddresses: string[];
  debouncer: Debouncer<TokenPrices, string>;

  constructor(tokenAddresses: string[], private chainId: Network = 1) {
    this.baseTokenAddresses = tokenAddresses.map(tokenAddressForPricing);
    this.urlBase = `https://api.coingecko.com/api/v3/simple/token_price/${this.platform(
      chainId
    )}?vs_currencies=usd,eth`;
    this.debouncer = new Debouncer<TokenPrices, string>(
      this.fetch.bind(this),
      200
    );
  }

  private async fetch(
    addresses: string[],
    { signal }: { signal?: AbortSignal } = {}
  ): Promise<TokenPrices> {
    console.time(`fetching coingecko for ${addresses.length} tokens`);

    const chunks = splitIntoChunks(addresses);

    const response = await Promise.all(
      chunks.map((chunk) =>
        axios
          .get<TokenPrices>(this.url(chunk), { signal })
          .then(({ data }) => {
            return data;
          })
          .catch((error) => {
            const message = ['Error fetching token prices from coingecko'];
            if (error.isAxiosError) {
              if (error.response?.status) {
                message.push(
                  `with status ${error.response.status}, all addresses ${addresses.length}, message: ${error.message}, \nerror: ${error}`
                );
              }
            } else {
              message.push(error);
            }
            return Promise.reject(message.join(' '));
          })
          .finally(() => {
            console.timeEnd(
              `fetching coingecko for ${addresses.length} tokens`
            );
          })
      )
    );

    let result: TokenPrices = {};

    for (const chunk of response) {
      result = { ...result, ...chunk };
    }

    return result;
  }

  private fetchNative({
    signal,
  }: { signal?: AbortSignal } = {}): Promise<Price> {
    console.time(`fetching coingecko for native token`);
    enum Assets {
      ETH = 'ethereum',
      MATIC = 'matic-network',
      XDAI = 'xdai',
    }
    let assetId: Assets = Assets.ETH;
    if (this.chainId === 137) assetId = Assets.MATIC;
    if (this.chainId === 100) assetId = Assets.XDAI;
    return axios
      .get<{ [key in Assets]: Price }>(
        `https://api.coingecko.com/api/v3/simple/price/?vs_currencies=eth,usd&ids=${assetId}`,
        { signal }
      )
      .then(({ data }) => {
        return data[assetId];
      })
      .catch((error) => {
        const message = ['Error fetching native token from coingecko'];
        if (error.isAxiosError) {
          if (error.response?.status) {
            message.push(`with status ${error.response.status}`);
          }
        } else {
          message.push(error);
        }
        return Promise.reject(message.join(' '));
      })
      .finally(() => {
        console.timeEnd(`fetching coingecko for native token`);
      });
  }

  find(inputAddress: string): Promise<Price | undefined> {
    const address = tokenAddressForPricing(inputAddress, this.chainId);
    if (!this.prices[address]) {
      // Make initial call with all the tokens we want to preload
      if (Object.keys(this.prices).length === 0) {
        for (const baseAddress of this.baseTokenAddresses) {
          this.prices[baseAddress] = this.debouncer
            .fetch(baseAddress)
            .then((prices) => prices[baseAddress]);
        }
      }

      // Handle native asset special case
      if (
        address === TOKENS(this.chainId).Addresses.nativeAsset.toLowerCase()
      ) {
        if (!this.nativePrice) {
          this.prices[address] = this.fetchNative();
        }

        return this.prices[address];
      }

      this.prices[address] = this.debouncer
        .fetch(address)
        .then((prices) => prices[address]);
    }

    return this.prices[address];
  }

  async findBy(attribute: string, value: string): Promise<Price | undefined> {
    if (attribute != 'address') {
      return undefined;
    }

    return this.find(value);
  }

  private platform(chainId: number): string {
    switch (chainId) {
      case 1:
      case 5:
      case 42:
      case 31337:
        return 'ethereum';
      case 100:
        return 'xdai';
      case 137:
        return 'polygon-pos';
      case 250:
        return 'fantom';
      case 1101:
        return 'polygon-zkevm';
      case 42161:
        return 'arbitrum-one';
      case 43114:
        return 'avalanche';
    }

    return '2';
  }

  private url(addresses: string[]): string {
    return `${this.urlBase}&contract_addresses=${addresses.join(',')}`;
  }
}
