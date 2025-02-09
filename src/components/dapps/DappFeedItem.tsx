import React, { memo } from '../../lib/teact/teact';
import { getActions } from '../../global';

import buildClassName from '../../util/buildClassName';
import { openUrl } from '../../util/openUrl';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Image from '../ui/Image';

import styles from './Dapp.module.scss';

interface OwnProps {
  iconUrl: string;
  name: string;
  url: string;
  mode: 'mini' | 'tile';
  origin: string;
}

const RERENDER_DAPPS_FEED_DELAY_MS = 1000;

const POPULAR_DAPP_ORIGIN_REPLACEMENTS = [
  {
    name: 'Fanzee Battles',
    manifestUrl: 'https://battles-tg-app.fanz.ee/tc-manifest.json',
    originalUrl: 'https://t.me/fanzeebattlesbot',
    replacementUrl: 'https://t.me/battlescryptobot?start=myTonWallet',
  },
  {
    name: 'Hamster Kombat',
    manifestUrl: 'https://hamsterkombatgame.io/tonconnect-manifest.json',
    originalUrl: 'https://hamsterkombatgame.io/',
    replacementUrl: 'https://t.me/hamster_kombat_bot/start',
  },
  {
    name: 'Dogs',
    manifestUrl: 'https://cdn.onetime.dog/manifest.json',
    originalUrl: 'https://onetime.dog',
    replacementUrl: 'https://t.me/dogshouse_bot/join',
  },
  {
    name: 'Earn',
    manifestUrl: 'https://cdn.joincommunity.xyz/earn/manifest.json',
    originalUrl: 'https://earncommunity.xyz',
    replacementUrl: 'https://t.me/earn?startapp',
  },
];

const ORIGIN_REPLACEMENTS_BY_ORIGIN = POPULAR_DAPP_ORIGIN_REPLACEMENTS.reduce(
  (acc: Record<string, string>, { originalUrl, replacementUrl }) => {
    acc[originalUrl] = replacementUrl;
    return acc;
  }, {},
);

function isTelegramUrl(url: string) {
  return url.startsWith('https://t.me/');
}

function DappFeedItem({
  iconUrl,
  name,
  url,
  mode,
  origin,
}: OwnProps) {
  const { updateDappLastOpenedAt } = getActions();
  const lang = useLang();

  function renderIcon() {
    const iconClassName = mode === 'mini' ? styles.feedItemLogoMini : styles.feedItemLogoTile;
    if (!iconUrl) {
      return (
        <div className={buildClassName(styles.dappLogo, styles.dappLogo_icon, iconClassName)}>
          <i className={buildClassName(styles.dappIcon, 'icon-laptop')} aria-hidden />
        </div>
      );
    }

    return (
      <div className={iconClassName}>
        <Image
          url={iconUrl}
          className={iconClassName}
          imageClassName={styles.feedItemLogoImg}
          alt={lang('Icon')}
        />
      </div>
    );
  }

  const openDapp = useLastCallback(async () => {
    const matchedUrl = ORIGIN_REPLACEMENTS_BY_ORIGIN[url];
    if (matchedUrl || isTelegramUrl(url)) {
      await openUrl(matchedUrl, true);
    } else {
      await openUrl(url);
    }
    setTimeout(() => void updateDappLastOpenedAt({ origin }), RERENDER_DAPPS_FEED_DELAY_MS);
  });

  return (
    <button
      className={buildClassName(styles.feedItem, mode === 'mini' ? styles.feedItemMini : styles.feedItemTile)}
      onClick={openDapp}
      type="button"
    >
      {renderIcon()}
      <span className={mode === 'mini' ? styles.feedItemAppNameMini : styles.feedItemAppNameTile}>{name}</span>
    </button>
  );
}

export default memo(DappFeedItem);
