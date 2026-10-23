-- Read-only verification. Import must also write the content-addressed files;
-- do not replace the importer with INSERT statements or copy local user UUIDs.
SELECT u.id, u.display_name
FROM app_users u
JOIN app_user_roles ur ON ur.user_id=u.id
JOIN app_roles r ON r.id=ur.role_id
WHERE u.status='active' AND r.code='admin';

SELECT s.id,s.canonical_name,s.visibility,s.enabled,s.published_version,
       v.state,v.manifest_hash,count(f.path) AS resource_count
FROM app_skills s
LEFT JOIN app_skill_versions v ON v.skill_id=s.id AND v.version=s.published_version
LEFT JOIN app_skill_files f ON f.skill_id=v.skill_id AND f.version=v.version
WHERE s.canonical_name='ppt' AND s.deleted_at IS NULL
GROUP BY s.id,v.skill_id,v.version;
