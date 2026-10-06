import { useRef, useState, type ReactNode } from 'react';
import { FolderTree, Settings2 } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

type Panel = 'config' | 'files';

export function RightPanelDock({ config, files }: { config: ReactNode; files: ReactNode }) {
  const [active, setActive] = useState<Panel | null>('config');
  const [desired, setDesired] = useState<Panel | null>('config');
  const desiredRef = useRef<Panel | null>('config');
  const reducedMotion = useReducedMotion();
  const duration = reducedMotion ? 0 : 0.28;

  function choose(panel: Panel) {
    const next = desiredRef.current === panel ? null : panel;
    desiredRef.current = next;
    setDesired(next);
    if (active && active !== next) setActive(null);
    else if (!active && !next) setActive(null);
    else if (!active && next && reducedMotion) setActive(next);
    else if (!active && next && desired === null) setActive(next);
  }

  return <motion.div className="right-panel-dock" initial={false}
    animate={{ width: active || desired ? 320 : 0 }} transition={{ duration }}>
    <div className="right-panel-toggles" role="group" aria-label="右侧面板">
      <button type="button" aria-label={desired === 'config' ? '收起 Config 面板' : '打开 Config 面板'}
        title="Config" aria-expanded={active === 'config'} aria-pressed={desired === 'config'}
        onClick={() => choose('config')}><Settings2 size={18} /></button>
      <button type="button" aria-label={desired === 'files' ? '收起文件管理面板' : '打开文件管理面板'}
        title="文件管理" aria-expanded={active === 'files'} aria-pressed={desired === 'files'}
        onClick={() => choose('files')}><FolderTree size={18} /></button>
    </div>
    <AnimatePresence mode="wait" initial={false} onExitComplete={() => setActive(desiredRef.current)}>
      {active && <motion.div key={active} className="right-panel-surface"
        initial={{ opacity: 0, x: 28 }} animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: 28 }} transition={{ duration }}>
        {active === 'config' ? config : files}
      </motion.div>}
    </AnimatePresence>
  </motion.div>;
}
