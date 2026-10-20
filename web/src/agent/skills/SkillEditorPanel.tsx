import { useEffect, type ReactNode } from 'react';

export function confirmSkillSwitch(dirty: boolean): boolean {
  return !dirty || window.confirm('有未保存的修改，是否放弃？');
}

export function SkillEditorPanel({
  dirty,
  onRequestClose,
  children,
}: {
  dirty: boolean;
  onRequestClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty]);

  function requestClose() {
    if (!confirmSkillSwitch(dirty)) return;
    onRequestClose();
  }

  return <div className="skills-detail-pane" aria-label="技能详情">
    <button type="button" className="skills-editor-back" onClick={requestClose}>返回</button>
    {children}
  </div>;
}
