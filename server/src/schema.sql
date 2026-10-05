-- 定向越野打卡争议复核系统 schema
-- 赛事单例 + 修订号（乐观锁）
CREATE TABLE IF NOT EXISTS event (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  name            TEXT NOT NULL,
  start_point     TEXT NOT NULL,
  finish_point    TEXT NOT NULL,
  finish_cutoff   INTEGER NOT NULL CHECK (finish_cutoff >= 0),
  revision        INTEGER NOT NULL DEFAULT 1
);

-- 按顺序通过的关卡组（seq 决定先后）
CREATE TABLE IF NOT EXISTS checkpoint_group (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  seq         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  cutoff_secs INTEGER CHECK (cutoff_secs IS NULL OR cutoff_secs >= 0)
);

-- 组内可替代点位（任选其一）
CREATE TABLE IF NOT EXISTS group_point (
  group_id INTEGER NOT NULL REFERENCES checkpoint_group(id) ON DELETE CASCADE,
  point    TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  PRIMARY KEY (group_id, point)
);

-- 统一停表区间（天气等原因赛事统一停表；距发枪秒数，左闭右开，[start,end)）
-- 全赛事单例集合：整体替换维护；重叠区间在核算时按并集只计一次。
CREATE TABLE IF NOT EXISTS stoppage_interval (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  start_secs INTEGER NOT NULL CHECK (start_secs >= 0),
  end_secs   INTEGER NOT NULL CHECK (end_secs >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (start_secs < end_secs)
);

CREATE TABLE IF NOT EXISTS runner (
  bib  TEXT PRIMARY KEY,
  name TEXT
);

-- 组别赛道：同场赛事可为不同参赛组别设置各自的赛道。
-- 每组别有自己按顺序通过的关卡组（含可替代点位与组截止）；
-- finish_cutoff 为 NULL 时沿用赛事统一的终点截止秒数。
-- 未指定组别的选手（runner_division 中无记录）沿用 event/checkpoint_group 的现有赛道。
CREATE TABLE IF NOT EXISTS division (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  finish_cutoff INTEGER CHECK (finish_cutoff IS NULL OR finish_cutoff >= 0),
  seq           INTEGER NOT NULL
);

-- 组别赛道的有序关卡组（seq 决定先后）
CREATE TABLE IF NOT EXISTS division_group (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  division_id INTEGER NOT NULL REFERENCES division(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  cutoff_secs INTEGER CHECK (cutoff_secs IS NULL OR cutoff_secs >= 0)
);

-- 组别关卡组内可替代点位（任选其一）
CREATE TABLE IF NOT EXISTS division_group_point (
  group_id INTEGER NOT NULL REFERENCES division_group(id) ON DELETE CASCADE,
  point    TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  PRIMARY KEY (group_id, point)
);

-- 选手归属（按号码布，一个号码布至多属于一个组别）
CREATE TABLE IF NOT EXISTS runner_division (
  bib         TEXT PRIMARY KEY REFERENCES runner(bib),
  division_id INTEGER NOT NULL REFERENCES division(id) ON DELETE CASCADE
);

-- 打卡原始读数。record_no 全局唯一。
-- status: active（有效，含被更正后的现值）| voided（裁判作废，不参与核算）
-- point/seconds/bib/kind 为「现值」（裁判更正会改 point/seconds）；
-- orig_* 为首次入库时的原始读数，永不随更正/作废/重导改变，
-- 是批量重导判定「同号内容是否一致」的唯一依据。
CREATE TABLE IF NOT EXISTS punch (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  record_no  TEXT NOT NULL UNIQUE,
  bib        TEXT NOT NULL REFERENCES runner(bib),
  point      TEXT NOT NULL,
  seconds    INTEGER NOT NULL CHECK (seconds >= 0),
  kind       TEXT NOT NULL CHECK (kind IN ('start','enroute','finish')),
  orig_bib     TEXT NOT NULL,
  orig_point   TEXT NOT NULL,
  orig_seconds INTEGER NOT NULL CHECK (orig_seconds >= 0),
  orig_kind    TEXT NOT NULL CHECK (orig_kind IN ('start','enroute','finish')),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided')),
  void_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_punch_bib ON punch(bib);

-- 裁判操作审计：作废 / 更正均保留原值与原因（更正只改 point/seconds）
CREATE TABLE IF NOT EXISTS punch_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  punch_id     INTEGER NOT NULL REFERENCES punch(id),
  action       TEXT NOT NULL CHECK (action IN ('void', 'correct')),
  orig_point   TEXT,
  orig_seconds INTEGER,
  new_point    TEXT,
  new_seconds  INTEGER,
  reason       TEXT NOT NULL,
  at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 发布快照（冻结，不可变）：同时冻结发布当时的停表区间、组别赛道与选手归属
CREATE TABLE IF NOT EXISTS publication (
  version         INTEGER PRIMARY KEY,
  event_revision  INTEGER NOT NULL,
  published_at    TEXT NOT NULL DEFAULT (datetime('now')),
  note            TEXT,
  config_json     TEXT NOT NULL,
  stoppages_json  TEXT NOT NULL DEFAULT '[]',
  divisions_json  TEXT NOT NULL DEFAULT '[]',
  assignments_json TEXT NOT NULL DEFAULT '[]',
  readings_json   TEXT NOT NULL,
  results_json    TEXT NOT NULL
);

-- 发布版成绩（便于排名查询），历史版永不被后续更正修改
-- elapsed=原始耗时；net_elapsed=发布当时按冻结停表区间算出的净耗时（未完赛为 NULL）
-- rank_no=全场净耗时名次；group_rank=同组完赛者内的净耗时名次（并列同名次，未完赛为 NULL）；
-- division=发布当时选手所属组别代码（未分组为 NULL）
CREATE TABLE IF NOT EXISTS published_result (
  publication_version INTEGER NOT NULL REFERENCES publication(version),
  bib         TEXT NOT NULL,
  name        TEXT,
  status      TEXT NOT NULL,
  elapsed     INTEGER,
  net_elapsed INTEGER,
  fail_at     TEXT,
  detail      TEXT,
  rank_no     INTEGER,
  group_rank  INTEGER,
  division    TEXT,
  PRIMARY KEY (publication_version, bib)
);

-- 杂项键值（如 seed 标记）
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
