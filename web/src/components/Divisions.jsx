import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

const EMPTY_DIVISION = () => ({
  code: '',
  name: '',
  finishCutoff: '',
  groups: [{ name: '', cutoffSecs: '', points: '' }],
});

/** 把赛事数据中的组别/归属转成可编辑草稿（点位数组 ↔ 逗号分隔字符串） */
function prefill(ev) {
  if (!ev?.configured) return null;
  return {
    divisions: (ev.divisions || []).map(d => ({
      code: d.code,
      name: d.name,
      finishCutoff: d.finishCutoff == null ? '' : String(d.finishCutoff),
      groups: d.groups.map(g => ({
        name: g.name,
        cutoffSecs: g.cutoffSecs == null ? '' : String(g.cutoffSecs),
        points: g.points.join(', '),
      })),
    })),
    assignments: Object.fromEntries((ev.assignments || []).map(a => [a.bib, a.division])),
  };
}

export default function Divisions({ event, onChanged, onError }) {
  const [divisions, setDivisions] = useState([]);
  const [assignments, setAssignments] = useState({}); // bib -> 组别代码（'' = 未分组）
  const [runners, setRunners] = useState([]);
  const [saved, setSaved] = useState(null); // null | 'saved' | 'noop'

  useEffect(() => {
    const p = prefill(event);
    if (p) {
      setDivisions(p.divisions);
      setAssignments(p.assignments);
    }
  }, [event]);

  // 选手名单（号码布 + 姓名）来自实时成绩接口
  useEffect(() => {
    api.results().then(d => {
      if (d?.configured) setRunners(d.results.map(r => ({ bib: r.bib, name: r.name })));
    }).catch(() => {});
  }, [event?.revision]);

  const setDiv = (i, patch) =>
    setDivisions(ds => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const setGroup = (di, gi, patch) =>
    setDivisions(ds => ds.map((d, j) =>
      j === di ? { ...d, groups: d.groups.map((g, k) => (k === gi ? { ...g, ...patch } : g)) } : d));

  /** 客户端即时校验，错误文案与后端 400 保持一致 */
  const errors = useMemo(() => {
    const errs = [];
    const codes = new Set();
    divisions.forEach((d, i) => {
      const where = `第 ${i + 1} 个组别`;
      const code = d.code.trim();
      if (!code) errs.push(`${where}：组别代码必填`);
      else if (codes.has(code)) errs.push(`组别代码「${code}」重复`);
      codes.add(code);
      if (!d.name.trim()) errs.push(`组别「${code || i + 1}」名称必填`);
      if (d.finishCutoff !== '' && (!Number.isInteger(Number(d.finishCutoff)) || Number(d.finishCutoff) < 0))
        errs.push(`组别「${code}」终点截止秒数须为非负整数或留空`);
      if (d.groups.length === 0) errs.push(`组别「${code}」至少设置一个关卡组`);
      const divPoints = new Set();
      d.groups.forEach((g, gi) => {
        const gwhere = `组别「${code}」第 ${gi + 1} 组`;
        if (!g.name.trim()) errs.push(`${gwhere} 名称非法`);
        if (g.cutoffSecs !== '' && (!Number.isInteger(Number(g.cutoffSecs)) || Number(g.cutoffSecs) < 0))
          errs.push(`${gwhere}「${g.name}」截止秒数须为非负整数或留空`);
        const pts = g.points.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
        if (pts.length === 0) errs.push(`${gwhere}「${g.name}」至少一个替代点位（空替代点位整次拒绝）`);
        pts.forEach(p => {
          if (divPoints.has(p)) errs.push(`点位 ${p} 在组别「${code}」的多个组中出现`);
          if (event && (p === event.startPoint || p === event.finishPoint))
            errs.push(`点位 ${p} 不能与起点/终点相同`);
          divPoints.add(p);
        });
      });
    });
    // 归属引用的组别代码必须存在
    Object.entries(assignments).forEach(([bib, code]) => {
      if (code && !codes.has(code)) errs.push(`号码布 ${bib} 指定的组别「${code}」不存在`);
    });
    return errs;
  }, [divisions, assignments, event]);

  const submit = async () => {
    if (!event?.configured) return onError(new Error('请先配置赛事'));
    if (errors.length) return onError(new Error(`${errors[0]}，整次拒绝`));
    setSaved(null);
    const payload = {
      expectedRevision: event.revision,
      divisions: divisions.map(d => ({
        code: d.code.trim(),
        name: d.name.trim(),
        finishCutoff: d.finishCutoff === '' ? null : Number(d.finishCutoff),
        groups: d.groups.map(g => ({
          name: g.name.trim(),
          cutoffSecs: g.cutoffSecs === '' ? null : Number(g.cutoffSecs),
          points: g.points.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean),
        })),
      })),
      assignments: Object.entries(assignments)
        .filter(([, code]) => code)
        .map(([bib, division]) => ({ bib, division })),
    };
    try {
      const r = await api.saveDivisions(payload);
      setSaved(r.changed ? 'saved' : 'noop');
      await onChanged();
      setTimeout(() => setSaved(null), 2500);
    } catch (err) {
      onError(err);
    }
  };

  if (!event?.configured) return <p className="muted">请先配置赛事。</p>;

  const codes = divisions.map(d => d.code.trim()).filter(Boolean);

  return (
    <div className="panel">
      <h2>组别赛道与号码布归属</h2>
      <p className="muted small">
        同场赛事可为不同<b>参赛组别</b>设置各自的赛道：按顺序通过的关卡组（每组含若干<b>可替代点位</b>）、
        组截止秒数与终点截止秒数（留空沿用赛事终点截止 {event.finishCutoff}s）。
        按<b>号码布</b>指定选手组别；<b>未分组者沿用「关卡设置」中的现有赛道</b>。
        选手按所属赛道构造有效链，停表与净耗时规则不变；<b>全场名次</b>仍按净耗时，
        另计<b>组内名次</b>（只在同组完赛者中排名、允许并列，未完赛者两种名次均为空；
        未分组完赛者在「默认赛道组」内计算组内名次）。
        保存须携带当前修订号，整体原子生效并立即使整案预演过期、实时成绩重算；
        未知组别、重复归属或空替代点位会被<b>整次拒绝</b>；已发布版本冻结当时配置，后续变更不改历史。
      </p>

      <h3>组别赛道（{divisions.length} 个）</h3>
      {divisions.map((d, di) => (
        <fieldset key={di} className="group-box">
          <legend>组别 {d.code || `#${di + 1}`}</legend>
          <div className="form-row three">
            <label>组别代码（唯一）
              <input value={d.code} onChange={e => setDiv(di, { code: e.target.value })} placeholder="如：ELITE" />
            </label>
            <label>组别名称
              <input value={d.name} onChange={e => setDiv(di, { name: e.target.value })} placeholder="如：精英组" />
            </label>
            <label>终点截止秒数（可空，沿用赛事）
              <input type="number" min="0" value={d.finishCutoff} onChange={e => setDiv(di, { finishCutoff: e.target.value })} />
            </label>
          </div>
          {d.groups.map((g, gi) => (
            <div className="form-row three" key={gi}>
              <label>第 {gi + 1} 组名
                <input value={g.name} onChange={e => setGroup(di, gi, { name: e.target.value })} placeholder="如：北山组" />
              </label>
              <label>组截止秒数（可空）
                <input type="number" min="0" value={g.cutoffSecs} onChange={e => setGroup(di, gi, { cutoffSecs: e.target.value })} />
              </label>
              <label>可替代点位（逗号分隔）
                <input value={g.points} onChange={e => setGroup(di, gi, { points: e.target.value })} placeholder="A1, A2" />
              </label>
            </div>
          ))}
          <button type="button" className="btn small"
            onClick={() => setDiv(di, { groups: [...d.groups, { name: '', cutoffSecs: '', points: '' }] })}>
            + 添加关卡组
          </button>
          {d.groups.length > 1 && (
            <button type="button" className="btn small danger"
              onClick={() => setDiv(di, { groups: d.groups.filter((_, k) => k !== d.groups.length - 1) })}>
              删除末组
            </button>
          )}
          <button type="button" className="btn small danger"
            onClick={() => {
              setDivisions(ds => ds.filter((_, j) => j !== di));
              // 组别删除后，指向它的归属一并清除（否则保存时按未知组别拒绝）
              if (d.code.trim()) {
                setAssignments(a => Object.fromEntries(Object.entries(a).filter(([, c]) => c !== d.code.trim())));
              }
            }}>
            删除该组别
          </button>
        </fieldset>
      ))}
      <button type="button" className="btn" onClick={() => setDivisions(ds => [...ds, EMPTY_DIVISION()])}>
        + 添加组别
      </button>

      <h3>号码布归属（{Object.values(assignments).filter(Boolean).length} 人已分组 / 共 {runners.length} 人）</h3>
      <table className="grid compact">
        <thead>
          <tr><th>号码布</th><th>姓名</th><th>所属组别（未选择 = 未分组，沿用现有赛道）</th></tr>
        </thead>
        <tbody>
          {runners.map(r => (
            <tr key={r.bib}>
              <td>{r.bib}</td>
              <td>{r.name || '—'}</td>
              <td>
                <select
                  value={assignments[r.bib] || ''}
                  onChange={e => setAssignments(a => {
                    const next = { ...a };
                    if (e.target.value) next[r.bib] = e.target.value;
                    else delete next[r.bib];
                    return next;
                  })}
                >
                  <option value="">未分组（默认赛道）</option>
                  {codes.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </td>
            </tr>
          ))}
          {runners.length === 0 && <tr><td colSpan="3" className="muted">暂无选手，请先导入打卡。</td></tr>}
        </tbody>
      </table>

      {errors.length > 0 && (
        <ul className="rules" style={{ color: '#c62828' }}>
          {errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}

      <div className="actions">
        <button className="btn primary" onClick={submit}>保存组别与归属（基于修订 #{event?.revision ?? '—'}）</button>
        {saved === 'saved' && <span className="ok-text">已保存</span>}
        {saved === 'noop' && <span className="muted small">内容与现状相同，未作变更（修订号不变）</span>}
      </div>
    </div>
  );
}
