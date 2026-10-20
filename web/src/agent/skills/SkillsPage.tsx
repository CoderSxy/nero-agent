import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { AgentShellContextValue } from '../AgentShell';
import { SkillEditor } from './SkillEditor';
import { SkillShortcutEditor } from './SkillShortcutForm';
import { SkillImportDialog } from './SkillImportDialog';
import { SkillSyncDialog } from './SkillSyncDialog';
import { SkillFiles } from './SkillFiles';
import { SkillPermissions } from './SkillPermissions';
import { SkillVersions } from './SkillVersions';
import {
  SkillApiError,
  createSkill,
  createWorkingDraft,
  deleteDraftFile,
  disableSkill,
  downloadSkillFile,
  enableSkill,
  getSkillDetail,
  listManageableSkills,
  listSkillFiles,
  listSkillGroups,
  listSkillVersions,
  patchSkillMetadata,
  publishSkill,
  rollbackSkill,
  saveDraft,
  uploadDraftFile,
} from './skills-api';
import type {
  SkillFileRecord,
  SkillGroupRecord,
  SkillManageDetail,
  SkillManageListItem,
  SkillVersionSummary,
} from './types';

type Tab = 'editor' | 'files' | 'versions' | 'permissions' | 'shortcut';

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function SkillsPage() {
  const { user } = useOutletContext<AgentShellContextValue>();
  const [items, setItems] = useState<SkillManageListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [qDraft, setQDraft] = useState('');
  const [groupId, setGroupId] = useState('');
  const [groups, setGroups] = useState<SkillGroupRecord[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillManageDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [localSkillMd, setLocalSkillMd] = useState('');
  const [serverSkillMd, setServerSkillMd] = useState('');
  const [conflict, setConflict] = useState(false);
  const [tab, setTab] = useState<Tab>('editor');
  const [files, setFiles] = useState<SkillFileRecord[]>([]);
  const [versions, setVersions] = useState<SkillVersionSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');

  const selectedIdRef = useRef<string | null>(null);
  const detailSeq = useRef(0);
  const mountedRef = useRef(true);
  const pageSize = 20;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  const refreshList = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const result = await listManageableSkills({
        page,
        pageSize,
        ...(q ? { q } : {}),
        ...(groupId ? { groupId } : {}),
      });
      if (!mountedRef.current) return;
      if (!Array.isArray(result.items)) throw new Error('技能列表响应格式错误');
      setItems(result.items);
      setTotal(result.total ?? result.items.length);
    } catch (cause) {
      if (!mountedRef.current) return;
      setItems([]);
      setTotal(0);
      setListError(cause instanceof Error ? cause.message : '加载技能列表失败');
    } finally {
      if (mountedRef.current) setListLoading(false);
    }
  }, [page, q, groupId]);

  useEffect(() => { void refreshList(); }, [refreshList]);

  useEffect(() => {
    let active = true;
    listSkillGroups().then(result => {
      if (active) setGroups(Array.isArray(result.items) ? result.items : []);
    }).catch(() => {
      if (active) setGroups([]);
    });
    return () => { active = false; };
  }, []);

  const applyDetail = useCallback((next: SkillManageDetail) => {
    setDetail(next);
    const md = next.draft?.skillMd ?? next.published?.skillMd ?? '';
    setServerSkillMd(md);
    setLocalSkillMd(md);
    setConflict(false);
    setActionError(null);
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    const seq = ++detailSeq.current;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const [next, versionPage] = await Promise.all([
        getSkillDetail(id),
        listSkillVersions(id).catch(() => ({ items: [] as SkillVersionSummary[] })),
      ]);
      if (!mountedRef.current || selectedIdRef.current !== id || seq !== detailSeq.current) return;
      applyDetail(next);
      setVersions(Array.isArray(versionPage.items) ? versionPage.items : []);
      const fileVersion = next.draft?.version ?? next.published?.version ?? null;
      if (fileVersion != null) {
        const filePage = await listSkillFiles(id, fileVersion);
        if (!mountedRef.current || selectedIdRef.current !== id || seq !== detailSeq.current) return;
        setFiles(Array.isArray(filePage.files) ? filePage.files : []);
      } else {
        setFiles([]);
      }
    } catch (cause) {
      if (!mountedRef.current || selectedIdRef.current !== id || seq !== detailSeq.current) return;
      setDetail(null);
      setDetailError(cause instanceof Error ? cause.message : '加载技能详情失败');
    } finally {
      if (mountedRef.current && seq === detailSeq.current) setDetailLoading(false);
    }
  }, [applyDetail]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setFiles([]);
      setVersions([]);
      setLocalSkillMd('');
      setServerSkillMd('');
      return;
    }
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const revision = detail?.skill.revision ?? '';
  const canEdit = detail?.canEdit === true;
  const canPublish = detail?.canPublish === true;
  const canManage = detail?.canManage === true;
  const dirty = localSkillMd !== serverSkillMd;

  async function withBusy(run: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await run();
    } catch (cause) {
      if (cause instanceof SkillApiError && cause.status === 409) {
        setConflict(true);
        setActionError(cause.message);
      } else {
        setActionError(cause instanceof Error ? cause.message : '操作失败');
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function handleSaveDraft() {
    if (!selectedId || !detail || !canEdit) return;
    await withBusy(async () => {
      try {
        const result = await saveDraft(selectedId, {
          expectedRevision: revision,
          skillMd: localSkillMd,
        });
        if (selectedIdRef.current !== selectedId) return;
        setDetail(prev => prev ? {
          ...prev,
          skill: result.skill,
          draft: result.version,
          canEdit: prev.canEdit,
          canPublish: prev.canPublish,
          canManage: prev.canManage,
        } : prev);
        setServerSkillMd(localSkillMd);
        setConflict(false);
        void refreshList();
      } catch (cause) {
        if (cause instanceof SkillApiError && cause.status === 409) {
          // Keep localSkillMd — do not overwrite with server content.
          setConflict(true);
        }
        throw cause;
      }
    });
  }

  async function handleReload() {
    if (!selectedId) return;
    await loadDetail(selectedId);
  }

  async function handleCreateDraft() {
    if (!selectedId || !canEdit) return;
    await withBusy(async () => {
      const result = await createWorkingDraft(selectedId, { expectedRevision: revision });
      if (selectedIdRef.current !== selectedId) return;
      setDetail(prev => prev ? {
        ...prev,
        skill: result.skill,
        draft: result.version,
      } : prev);
      setServerSkillMd(result.version.skillMd);
      setLocalSkillMd(result.version.skillMd);
      setConflict(false);
      await loadDetail(selectedId);
    });
  }

  async function handlePublish(version: number) {
    if (!selectedId || !detail || !canPublish) return;
    const prevEnabled = detail.skill.enabled;
    const prevPublished = detail.skill.publishedVersion;
    await withBusy(async () => {
      try {
        const result = await publishSkill(selectedId, { expectedRevision: revision, version });
        if (selectedIdRef.current !== selectedId) return;
        setDetail(prev => prev ? {
          ...prev,
          skill: result.skill,
          draft: null,
          published: result.version,
        } : prev);
        void refreshList();
        await loadDetail(selectedId);
      } catch (cause) {
        // Publish failure must not fake-update enabled / publishedVersion.
        setDetail(prev => prev ? {
          ...prev,
          skill: {
            ...prev.skill,
            enabled: prevEnabled,
            publishedVersion: prevPublished,
          },
        } : prev);
        throw cause;
      }
    });
  }

  async function handleRollback(targetVersion: number) {
    if (!selectedId || !canPublish) return;
    await withBusy(async () => {
      await rollbackSkill(selectedId, { expectedRevision: revision, targetVersion });
      if (selectedIdRef.current !== selectedId) return;
      await loadDetail(selectedId);
      void refreshList();
    });
  }

  async function handleEnable() {
    if (!selectedId || !canManage) return;
    await withBusy(async () => {
      const result = await enableSkill(selectedId, revision);
      if (selectedIdRef.current !== selectedId) return;
      setDetail(prev => prev ? { ...prev, skill: result.skill } : prev);
      void refreshList();
    });
  }

  async function handleDisable() {
    if (!selectedId || !canManage) return;
    await withBusy(async () => {
      const result = await disableSkill(selectedId, revision);
      if (selectedIdRef.current !== selectedId) return;
      setDetail(prev => prev ? { ...prev, skill: result.skill } : prev);
      void refreshList();
    });
  }

  async function handleUpload(path: string, file: File) {
    if (!selectedId || !canEdit) return;
    await withBusy(async () => {
      const result = await uploadDraftFile(selectedId, {
        expectedRevision: revision,
        path,
        bytes: file,
        contentType: file.type || undefined,
      });
      if (selectedIdRef.current !== selectedId) return;
      setDetail(prev => prev ? { ...prev, skill: result.skill, draft: result.version } : prev);
      const filePage = await listSkillFiles(selectedId, result.version.version);
      if (selectedIdRef.current !== selectedId) return;
      setFiles(Array.isArray(filePage.files) ? filePage.files : []);
    });
  }

  async function handleDeleteFile(path: string) {
    if (!selectedId || !canEdit) return;
    if (!window.confirm(`删除资源 ${path}？`)) return;
    await withBusy(async () => {
      const result = await deleteDraftFile(selectedId, { expectedRevision: revision, path });
      if (selectedIdRef.current !== selectedId) return;
      setDetail(prev => prev ? { ...prev, skill: result.skill, draft: result.version } : prev);
      const filePage = await listSkillFiles(selectedId, result.version.version);
      if (selectedIdRef.current !== selectedId) return;
      setFiles(Array.isArray(filePage.files) ? filePage.files : []);
    });
  }

  async function handleDownload(path: string, _isText: boolean) {
    if (!selectedId || !detail) return;
    const version = detail.draft?.version ?? detail.published?.version;
    if (version == null) return;
    try {
      const blob = await downloadSkillFile(selectedId, version, path);
      triggerBlobDownload(blob, path.split('/').pop() || 'download');
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '下载失败');
    }
  }

  async function handleSavePermissions(input: {
    visibility: SkillManageDetail['skill']['visibility'];
    groupId: string | null;
    grants: { userId: string; permission: 'use' | 'edit' | 'publish' }[];
  }) {
    if (!selectedId || !canManage) return;
    await withBusy(async () => {
      const result = await patchSkillMetadata(selectedId, {
        expectedRevision: revision,
        visibility: input.visibility,
        groupId: input.groupId,
        grants: input.grants,
      });
      if (selectedIdRef.current !== selectedId) return;
      setDetail(prev => prev ? { ...prev, skill: result.skill, grants: input.grants } : prev);
      void refreshList();
    });
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    await withBusy(async () => {
      const result = await createSkill({
        name: createName.trim(),
        description: createDescription.trim(),
      });
      setCreateOpen(false);
      setCreateName('');
      setCreateDescription('');
      await refreshList();
      setSelectedId(result.skill.id);
      setTab('editor');
    });
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const workingVersion = detail?.draft?.version ?? null;
  const publishedVersion = detail?.skill.publishedVersion ?? null;
  const fileVersion = workingVersion ?? publishedVersion;

  return <section className="agent-center skills-page" role="region" aria-label="技能管理">
    <div className="skills-layout">
      <aside className="skills-list-pane" aria-label="技能列表">
        <header className="skills-header">
          <div>
            <h1>技能管理</h1>
            <p>维护私有草稿、发布与启用；保存不会自动发布。</p>
          </div>
          <div className="skills-header-actions">
            <button type="button" onClick={() => setCreateOpen(true)}>新建技能</button>
            <button type="button" onClick={() => setImportOpen(true)}>导入技能包</button>
          </div>
        </header>
        <form className="skills-search" onSubmit={event => {
          event.preventDefault();
          setPage(1);
          setQ(qDraft.trim());
        }}>
          <input
            aria-label="搜索技能"
            placeholder="搜索名称"
            value={qDraft}
            onChange={event => setQDraft(event.target.value)}
          />
          <select
            aria-label="分类筛选"
            value={groupId}
            onChange={event => { setPage(1); setGroupId(event.target.value); }}
          >
            <option value="">全部分类</option>
            {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
          <button type="submit">搜索</button>
        </form>
        {listLoading ? <p role="status">加载中…</p> : null}
        {listError ? <p role="alert">{listError}</p> : null}
        {!listLoading && !listError && items.length === 0 ? (
          <div className="skills-empty"><strong>暂无技能</strong><span>点击“新建技能”创建 private 草稿。</span></div>
        ) : null}
        <ul className="skills-list">
          {items.map(item => <li key={item.id}>
            <button
              type="button"
              className={selectedId === item.id ? 'active' : undefined}
              aria-current={selectedId === item.id ? 'true' : undefined}
              onClick={() => { setSelectedId(item.id); setTab('editor'); }}
            >
              <strong>{item.canonicalName}</strong>
              <small>
                {item.enabled ? '启用' : '停用'}
                {item.publishedVersion != null ? ` · 发布 v${item.publishedVersion}` : ' · 未发布'}
                {item.canEdit ? ' · 可编辑' : ''}
              </small>
            </button>
          </li>)}
        </ul>
        <div className="skills-pagination">
          <button type="button" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</button>
          <span>{page} / {pageCount}</span>
          <button type="button" disabled={page >= pageCount} onClick={() => setPage(p => p + 1)}>下一页</button>
        </div>
      </aside>

      <div className="skills-detail-pane" aria-label="技能详情">
        {!selectedId ? <div className="skills-empty"><strong>选择技能</strong><span>从左侧打开可维护的技能。</span></div> : null}
        {selectedId && detailLoading ? <p role="status">加载详情…</p> : null}
        {selectedId && detailError ? <p role="alert">{detailError}</p> : null}
        {selectedId && detail ? <>
          <header className="skills-detail-header">
            <div>
              <h2>{detail.skill.canonicalName}</h2>
              <p>
                revision {detail.skill.revision}
                <span aria-hidden="true"> · </span>
                {detail.skill.visibility}
                <span aria-hidden="true"> · </span>
                {user.displayName}
              </p>
            </div>
            <nav className="skills-tabs" aria-label="技能面板">
              {([
                ['editor', '正文'],
                ['files', '资源'],
                ['versions', '版本'],
                ['permissions', '权限'],
                ...(canManage ? [['shortcut', '快捷'] as const] : []),
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={tab === id}
                  onClick={() => setTab(id)}
                >{label}</button>
              ))}
            </nav>
          </header>
          {actionError ? <p role="alert">{actionError}</p> : null}
          {tab === 'editor' ? (
            <SkillEditor
              skillMd={localSkillMd}
              onChange={setLocalSkillMd}
              canEdit={canEdit}
              dirty={dirty}
              saving={busy}
              conflict={conflict}
              onSave={() => void handleSaveDraft()}
              onReload={() => void handleReload()}
              workingVersion={workingVersion}
              publishedVersion={publishedVersion}
              canConfigureShortcut={canManage}
              onConfigureShortcut={() => setTab('shortcut')}
            />
          ) : null}
          {tab === 'files' ? (
            <SkillFiles
              files={files}
              version={fileVersion}
              canEdit={canEdit}
              busy={busy}
              onUpload={(path, file) => void handleUpload(path, file)}
              onDelete={path => void handleDeleteFile(path)}
              onDownload={(path, isText) => void handleDownload(path, isText)}
            />
          ) : null}
          {tab === 'versions' ? <>
            <div className="skill-panel-actions">
              <button type="button" onClick={() => setSyncOpen(true)}>同步与导出</button>
            </div>
            <SkillSyncDialog
              open={syncOpen}
              skillId={detail.skill.id}
              expectedRevision={detail.skill.revision}
              canEdit={canEdit}
              canMaintain={canEdit || canPublish || canManage}
              enabledVersion={detail.skill.enabled ? publishedVersion : null}
              versions={versions}
              onClose={() => setSyncOpen(false)}
              onCommitted={() => { if (selectedId) void loadDetail(selectedId); }}
            />
            <SkillVersions
              versions={versions}
              publishedVersion={publishedVersion}
              draftVersion={workingVersion}
              enabled={detail.skill.enabled}
              canEdit={canEdit}
              canPublish={canPublish}
              canManage={canManage}
              busy={busy}
              onCreateDraft={() => void handleCreateDraft()}
              onPublish={version => void handlePublish(version)}
              onRollback={version => void handleRollback(version)}
              onEnable={() => void handleEnable()}
              onDisable={() => void handleDisable()}
            />
          </> : null}
          {tab === 'shortcut' && canManage ? <SkillShortcutEditor skillId={detail.skill.id} canManage={canManage} /> : null}
          {tab === 'permissions' ? (
            <SkillPermissions
              key={detail.skill.id + detail.skill.revision}
              visibility={detail.skill.visibility}
              groupId={detail.skill.groupId}
              groups={groups}
              grants={detail.grants}
              canManage={canManage}
              busy={busy}
              onSave={input => void handleSavePermissions(input)}
            />
          ) : null}
        </> : null}
      </div>
    </div>

    <SkillImportDialog
      open={importOpen}
      onClose={() => setImportOpen(false)}
      onCommitted={(skillId) => {
        setSelectedId(skillId);
        void refreshList();
      }}
    />
    {createOpen ? <div className="scheduled-task-modal-backdrop" onClick={() => setCreateOpen(false)}>
      <div
        className="scheduled-task-modal skills-create-modal"
        role="dialog"
        aria-label="新建技能"
        onClick={event => event.stopPropagation()}
      >
        <form onSubmit={event => void handleCreate(event)}>
          <header className="scheduled-task-modal-header">
            <div><small>技能</small><h2>新建 private 草稿</h2></div>
            <button type="button" aria-label="关闭" onClick={() => setCreateOpen(false)}>×</button>
          </header>
          <div className="scheduled-task-modal-body">
            <label>规范名
              <input aria-label="规范名" required value={createName}
                onChange={event => setCreateName(event.target.value)}
                placeholder="my-skill" />
            </label>
            <label>描述
              <textarea aria-label="描述" required rows={3} value={createDescription}
                onChange={event => setCreateDescription(event.target.value)} />
            </label>
          </div>
          <footer className="scheduled-task-modal-footer">
            <button type="button" onClick={() => setCreateOpen(false)}>取消</button>
            <button type="submit" disabled={busy}>创建</button>
          </footer>
        </form>
      </div>
    </div> : null}
  </section>;
}
