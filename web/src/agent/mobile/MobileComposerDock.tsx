import type { ReactNode } from 'react';

export function MobileComposerDock({ children }: { children: ReactNode }) {
  return <div className="mobile-composer-dock">{children}</div>;
}
