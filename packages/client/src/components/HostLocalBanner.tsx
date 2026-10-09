import { useHostInfo } from '../hooks/useHostInfo';

function isPublicTunnelHost(hostname: string): boolean {
  return (
    hostname.endsWith('.trycloudflare.com') ||
    hostname.endsWith('.cfargotunnel.com')
  );
}

/**
 * When the browser is on the public/tunnel origin, nudge the operator to the
 * loopback equivalent. Host-machine tabs through cloudflared often stick on
 * RECONNECTING while remote clients on the same URL stay LIVE.
 */
export function HostLocalBanner() {
  const hostInfo = useHostInfo();

  if (typeof window === 'undefined') return null;

  const { protocol, hostname, port, pathname, search, hash } = window.location;
  const onTunnelHost = isPublicTunnelHost(hostname);
  const publicBase = hostInfo?.publicBaseUrl?.replace(/\/+$/, '') ?? null;
  let onConfiguredPublic = false;
  if (publicBase) {
    try {
      const pub = new URL(publicBase);
      onConfiguredPublic =
        pub.hostname === hostname &&
        (pub.port || (pub.protocol === 'https:' ? '443' : '80')) ===
          (port || (protocol === 'https:' ? '443' : '80'));
    } catch {
      onConfiguredPublic = false;
    }
  }

  if (!onTunnelHost && !onConfiguredPublic) return null;

  const listenPort = hostInfo?.listenPort ?? 8787;
  const localUrl = `http://127.0.0.1:${listenPort}${pathname}${search}${hash}`;

  return (
    <div className="host-local-banner" role="status">
      <p>
        <strong>Host machine:</strong> you are on the public/tunnel URL. Open this
        page on{' '}
        <a className="mono" href={localUrl}>
          {localUrl}
        </a>{' '}
        instead — keep umpire and your own station tabs on loopback. Remotes keep
        using the tunnel links from <strong>Player join URLs → Copy</strong>.
      </p>
    </div>
  );
}
