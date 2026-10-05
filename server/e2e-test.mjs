// 端到端断言：需在独立干净数据库上启动的服务器上运行（SEED=1）。
// 用法：node server/e2e-test.mjs http://localhost:3000
const BASE = process.argv[2] || 'http://localhost:3000';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra); }
}
async function call(path, opts) {
  const res = await fetch(BASE + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

const resultsByBib = async () => {
  const r = await call('/api/results');
  return new Map(r.body.results.map(x => [x.bib, x]));
};
const rev = async () => (await call('/api/event')).body.revision;

console.log('1) 种子赛事与初始排名');
{
  const ev = (await call('/api/event')).body;
  ok('赛事已配置', ev.configured);
  const seedRev = await rev();
  ok('种子完成后修订号为 1（配置与演示读数在同一初始事务落库）', seedRev === 1, `rev=${seedRev}`);
  const rs = await resultsByBib();
  ok('001 完成 910 第一', rs.get('001').status === 'ok' && rs.get('001').elapsed === 910 && rs.get('001').rank === 1);
  ok('001 最早链排除逆序 A1@820/取 A2@300', JSON.stringify(rs.get('001').chain.map(c => c.point)) === JSON.stringify(['S','A2','B1','F']));
  ok('004/006 同耗时 1000 并列第 2', rs.get('004').rank === 2 && rs.get('006').rank === 2 && rs.get('004').elapsed === 1000);
  ok('004 多余点 ZZ@99999 不入链', rs.get('004').chain.every(c => c.point !== 'ZZ'));
  ok('002 终点超时并给出秒数', rs.get('002').status === 'finish_dnf' && rs.get('002').failAt === '终点' && /1850/.test(rs.get('002').detail));
  ok('003 首个未完成组=湖畔组', rs.get('003').status === 'group_dnf' && rs.get('003').failAt === '湖畔组');
  ok('005 出发不唯一', rs.get('005').status === 'bad_start');
}

console.log('2) 整批拒绝规则');
{
  const r0 = await rev();
  const neg = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r0, punches: [
    { recordNo: 'B1', bib: '050', point: 'S', seconds: 0, kind: 'start' },
    { recordNo: 'B2', bib: '050', point: 'A1', seconds: -3, kind: 'enroute' },
  ]})});
  ok('负秒数 400 整批拒绝', neg.status === 400 && /负秒数/.test(neg.body.error));
  const dupDb = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r0, punches: [
    { recordNo: 'R0001', bib: '001', point: 'S', seconds: 999, kind: 'start' },
  ]})});
  ok('同记录号异内容（与库冲突）400', dupDb.status === 400 && /R0001/.test(dupDb.body.error));
  const dupBatch = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r0, punches: [
    { recordNo: 'B9', bib: '050', point: 'S', seconds: 0, kind: 'start' },
    { recordNo: 'B9', bib: '050', point: 'F', seconds: 5, kind: 'finish' },
  ]})});
  ok('批次内同记录号异内容 400', dupBatch.status === 400 && /B9/.test(dupBatch.body.error));
  const after = await call('/api/punches?bib=050');
  ok('整批回滚：050 无任何打卡', after.body.punches.length === 0);
}

console.log('3) 修订号乐观锁');
{
  const r0 = await rev();
  const stale = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r0 + 999, punches: [
    { recordNo: 'S1', bib: '060', point: 'S', seconds: 0, kind: 'start' },
  ]})});
  ok('过期修订 409 且返回当前修订', stale.status === 409 && stale.body.currentRevision === r0);
  const missing = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ punches: [] })});
  ok('缺 expectedRevision 400', missing.status === 400);
}

console.log('4) 合法导入与幂等');
{
  const r0 = await rev();
  const imp = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r0, punches: [
    { recordNo: 'R0001', bib: '001', point: 'S', seconds: 0, kind: 'start' },
    { recordNo: 'E1', bib: '008', name: '测试选手', point: 'S', seconds: 0, kind: 'start' },
    { recordNo: 'E2', bib: '008', point: 'A2', seconds: 150, kind: 'enroute' },
    { recordNo: 'E3', bib: '008', point: 'B1', seconds: 600, kind: 'enroute' },
    { recordNo: 'E4', bib: '008', point: 'F', seconds: 777, kind: 'finish' },
  ]})});
  ok('导入成功，4 新增 1 跳过', imp.status === 200 && imp.body.inserted === 4 && imp.body.skipped === 1);
  ok('导入后修订号 +1', imp.body.revision === r0 + 1);
  const rs = await resultsByBib();
  ok('008 完成 777（B1 恰在组截止 600 有效；终点 777<=1800）', rs.get('008').elapsed === 777 && rs.get('008').rank === 1);
}

console.log('5) 作废/更正留痕并重算');
{
  // 005 两条出发：R0040 id=20, R0041 id=21
  const noReason = await call('/api/punches/21/void', { method: 'POST', body: JSON.stringify({}) });
  ok('作废无原因 400', noReason.status === 400);
  const v = await call('/api/punches/21/void', { method: 'POST', body: JSON.stringify({ reason: '设备重复上报' }) });
  ok('作废成功并推进修订', v.status === 200);
  const rs1 = await resultsByBib();
  ok('作废重复出发后 005 以 980 完成', rs1.get('005').status === 'ok' && rs1.get('005').elapsed === 980);
  const neg = await call('/api/punches/17/correct', { method: 'POST', body: JSON.stringify({ reason: 'x', newPoint: 'A1', newSeconds: -1 }) });
  ok('更正为负秒数 400', neg.status === 400);
  const c = await call('/api/punches/17/correct', { method: 'POST', body: JSON.stringify({ reason: '现场记录更正', newPoint: 'B2', newSeconds: 700 }) });
  ok('更正成功', c.status === 200);
  const rs2 = await resultsByBib();
  // 004 原有 A1@400, B2@720；把 ZZ 改为 B2@700 后，组2取更早的 B2@700，终点仍 F@1000
  const chain4 = rs2.get('004').chain.map(x => `${x.point}@${x.seconds}`);
  ok('004 链采用更正后的更早 B2@700', chain4.includes('B2@700') && !chain4.includes('B2@720'), chain4.join(' '));
  const audits = (await call('/api/punches?bib=004')).body.audits;
  const a = audits.find(x => x.action === 'correct');
  ok('审计保留原值 ZZ@99999', a && a.origPoint === 'ZZ' && a.origSeconds === 99999 && a.newPoint === 'B2' && a.reason === '现场记录更正');
}

console.log('6) 发布冻结与历史版不可变');
{
  const before = await resultsByBib();
  const v005 = before.get('005').elapsed;
  const r0 = await rev();
  const pub = await call('/api/publications', { method: 'POST', body: JSON.stringify({ expectedRevision: r0, note: '冻结首版' }) });
  ok('发布 v1 成功', pub.status === 200 && pub.body.version === 1);
  const stalePub = await call('/api/publications', { method: 'POST', body: JSON.stringify({ expectedRevision: r0 }) });
  ok('发布后旧修订再发布 409', stalePub.status === 409);
  const snap = (await call('/api/publications/1')).body;
  ok('v1 快照 005 成绩=' + v005, snap.results.find(x => x.bib === '005').elapsed === v005);
  ok('v1 快照不含作废读数（005 仅 4 条）', snap.readings.filter(x => x.bib === '005').length === 4);

  // 发布之后：更正 001 的 A2@300 -> A1@250，再发布 v2
  const p1 = (await call('/api/punches?bib=001')).body.punches.find(x => x.record_no === 'R0003');
  const r1 = await rev();
  const cor = await call(`/api/punches/${p1.id}/correct`, { method: 'POST', body: JSON.stringify({ reason: '发布后申诉更正', newPoint: 'A1', newSeconds: 250 }) });
  ok('发布后更正成功', cor.status === 200);
  const r2 = await rev();
  const pub2 = await call('/api/publications', { method: 'POST', body: JSON.stringify({ expectedRevision: r2, note: '第二版' }) });
  ok('发布 v2', pub2.status === 200 && pub2.body.version === 2);
  const snap1 = (await call('/api/publications/1')).body;
  const snap2 = (await call('/api/publications/2')).body;
  ok('v1 历史版读数仍是旧 A2@300', snap1.readings.find(x => x.record_no === 'R0003').point === 'A2' && snap1.readings.find(x => x.record_no === 'R0003').seconds === 300);
  ok('v2 读数为更正后 A1@250', snap2.readings.find(x => x.record_no === 'R0003').point === 'A1' && snap2.readings.find(x => x.record_no === 'R0003').seconds === 250);
  ok('v1/v2 配置均已冻结', snap1.config.groups.length === 2 && snap2.config.groups.length === 2);
  const list = (await call('/api/publications')).body.publications;
  ok('版本列表按版本倒序', list[0].version === 2 && list[1].version === 1);
}

console.log('7) 更正/作废后的重导语义（按首次入库原始读数判定）');
{
  const rNow = await rev();

  // 7.1 R0003 已更正为 A1@250；用最初读数 A2@300 重导 => 幂等跳过，现值/审计不动
  const sameOrig = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: rNow, punches: [
    { recordNo: 'R0003', bib: '001', point: 'A2', seconds: 300, kind: 'enroute' },
  ]})});
  ok('更正后按原始读数重导：200 跳过 0 新增', sameOrig.status === 200 && sameOrig.body.inserted === 0 && sameOrig.body.skipped === 1);
  ok('全部跳过时修订号不变', sameOrig.body.revision === rNow);
  const p3 = (await call('/api/punches?bib=001')).body.punches.find(x => x.record_no === 'R0003');
  ok('跳过不覆盖裁判现值（仍 A1@250）', p3.point === 'A1' && p3.seconds === 250);
  ok('API 返回首次入库原始读数 A2@300', p3.orig_point === 'A2' && p3.orig_seconds === 300);
  const rs = await resultsByBib();
  ok('实时成绩沿用裁判现值（001 链含 A1@250，耗时仍 910）',
    rs.get('001').chain.some(c => c.point === 'A1' && c.seconds === 250) && rs.get('001').elapsed === 910);

  // 7.2 与更正现值一致但与原始读数不同 => 仍按冲突整批拒绝（不能错误跳过）
  const matchCurrent = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: rNow, punches: [
    { recordNo: 'R0003', bib: '001', point: 'A1', seconds: 250, kind: 'enroute' },
  ]})});
  ok('同号但仅与现值一致、异于原始读数：400', matchCurrent.status === 400 && /R0003/.test(matchCurrent.body.error));

  // 7.3 冲突批次混有新记录 => 整批拒绝，不部分入库
  const mixed = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: rNow, punches: [
    { recordNo: 'R0003', bib: '001', point: 'A2', seconds: 999, kind: 'enroute' },
    { recordNo: 'N1', bib: '070', name: '不应入库', point: 'S', seconds: 0, kind: 'start' },
  ]})});
  ok('冲突+新记录混批 400 且不部分入库', mixed.status === 400);
  const afterMixed = await call('/api/punches?bib=070');
  ok('混批回滚：070 无 runner/打卡', afterMixed.body.punches.length === 0);
  const rAfterMixed = await rev();
  ok('混批拒绝后修订号不变', rAfterMixed === rNow);

  // 7.4 多次更正后仍按最初读数判断：把 002 的 R0011 再更正一次 A1@200 -> A2@260
  const r0 = await rev();
  const target = (await call('/api/punches?bib=002')).body.punches.find(x => x.record_no === 'R0011');
  const c1 = await call(`/api/punches/${target.id}/correct`, { method: 'POST', body: JSON.stringify({ reason: '第一次更正', newPoint: 'A1', newSeconds: 210 }) });
  ok('第二次更正（中间值 A1@210）成功', c1.status === 200);
  const c2 = await call(`/api/punches/${target.id}/correct`, { method: 'POST', body: JSON.stringify({ reason: '第二次更正', newPoint: 'A2', newSeconds: 260 }) });
  ok('第三次更正（现值 A2@260）成功', c2.status === 200);
  const r1 = await rev();
  const reOrig = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r1, punches: [
    { recordNo: 'R0011', bib: '002', point: 'A1', seconds: 200, kind: 'enroute' },
  ]})});
  ok('多次更正后按最初读数 A1@200 重导：跳过', reOrig.status === 200 && reOrig.body.skipped === 1);
  const reMiddle = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r1, punches: [
    { recordNo: 'R0011', bib: '002', point: 'A1', seconds: 210, kind: 'enroute' },
  ]})});
  ok('用中间更正值 A1@210 重导：400 拒绝', reMiddle.status === 400 && /R0011/.test(reMiddle.body.error));
  const audits2 = (await call('/api/punches?bib=002')).body.audits.filter(a => a.punchId === target.id);
  ok('重导未新增审计（仍为 2 条更正）', audits2.length === 2);

  // 7.5 作废记录重导原始读数：跳过且不恢复有效状态
  const r2 = await rev();
  const voided = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r2, punches: [
    { recordNo: 'R0041', bib: '005', point: 'S', seconds: 5, kind: 'start' },
  ]})});
  ok('已作废记录按原始读数重导：跳过', voided.status === 200 && voided.body.inserted === 0 && voided.body.skipped === 1);
  const p41 = (await call('/api/punches?bib=005')).body.punches.find(x => x.record_no === 'R0041');
  ok('跳过后仍为 voided、原因保留', p41.status === 'voided' && /设备重复上报/.test(p41.void_reason || ''));

  // 7.6 历史发布版保持冻结：v1 读数不受此后更正/重导影响
  const snap1 = (await call('/api/publications/1')).body;
  ok('v1 历史版仍冻结在发布时读数（R0003=A2@300）',
    snap1.readings.find(x => x.record_no === 'R0003').point === 'A2' &&
    snap1.readings.find(x => x.record_no === 'R0003').seconds === 300);

  // 7.7 过期修订重导：409 + currentRevision
  const r3 = await rev();
  const stale = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r3 - 1, punches: [
    { recordNo: 'R0003', bib: '001', point: 'A2', seconds: 300, kind: 'enroute' },
  ]})});
  ok('重导过期修订 409 并返回 currentRevision', stale.status === 409 && stale.body.currentRevision === r3);

  // 7.8 原始批次（多条已更正/作废）+ 新记录混合：已有全部跳过，新记录入库，修订 +1
  const r4 = await rev();
  const batch = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r4, punches: [
    { recordNo: 'R0003', bib: '001', point: 'A2', seconds: 300, kind: 'enroute' },
    { recordNo: 'R0011', bib: '002', point: 'A1', seconds: 200, kind: 'enroute' },
    { recordNo: 'R0041', bib: '005', point: 'S', seconds: 5, kind: 'start' },
    { recordNo: 'N9', bib: '080', name: '新选手', point: 'S', seconds: 0, kind: 'start' },
  ]})});
  ok('原批次重导+新记录：3 跳过 1 新增', batch.status === 200 && batch.body.inserted === 1 && batch.body.skipped === 3);
  ok('有新增时修订号 +1', batch.body.revision === r4 + 1);
  const still = (await call('/api/punches?bib=001')).body.punches.find(x => x.record_no === 'R0003');
  ok('重导后裁判现值仍不被覆盖（A1@250）', still.point === 'A1' && still.seconds === 250);
}

console.log('8) 整案申诉：预演 + 确认（原子提交、修订绑定、名次联动）');
{
  // 8.1 导入三名选手：090 有三条待处理争议读数（重复出发/ZZ 错误点/终点超时）；
  //     091=700s、092=800s 为完成者（全库此时另有 008=777s 插在两人之间）
  const r0 = await rev();
  const setup = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r0, punches: [
    { recordNo: 'C001', bib: '090', name: '申诉甲', point: 'S', seconds: 0, kind: 'start' },
    { recordNo: 'C002', bib: '090', point: 'S', seconds: 5, kind: 'start' },
    { recordNo: 'C005', bib: '090', point: 'A1', seconds: 300, kind: 'enroute' },
    { recordNo: 'C003', bib: '090', point: 'ZZ', seconds: 9999, kind: 'enroute' },
    { recordNo: 'C004', bib: '090', point: 'F', seconds: 2000, kind: 'finish' },
    { recordNo: 'C101', bib: '091', name: '旁观乙', point: 'S', seconds: 0, kind: 'start' },
    { recordNo: 'C102', bib: '091', point: 'A1', seconds: 200, kind: 'enroute' },
    { recordNo: 'C103', bib: '091', point: 'B1', seconds: 500, kind: 'enroute' },
    { recordNo: 'C104', bib: '091', point: 'F', seconds: 700, kind: 'finish' },
    { recordNo: 'C201', bib: '092', name: '旁观丙', point: 'S', seconds: 0, kind: 'start' },
    { recordNo: 'C202', bib: '092', point: 'A2', seconds: 200, kind: 'enroute' },
    { recordNo: 'C203', bib: '092', point: 'B2', seconds: 500, kind: 'enroute' },
    { recordNo: 'C204', bib: '092', point: 'F', seconds: 800, kind: 'finish' },
  ]})});
  ok('8.1 三人数据导入成功（13 条）', setup.status === 200 && setup.body.inserted === 13);
  const idOf = async (recordNo) =>
    (await (await fetch(`${BASE}/api/punches?bib=090`, { headers: { 'Content-Type': 'application/json' } })).json())
      .punches.find(x => x.record_no === recordNo).id;
  const idC002 = await idOf('C002');
  const idC003 = await idOf('C003');
  const idC004 = await idOf('C004');

  const before = await resultsByBib();
  ok('8.2 预演前 090 出发不唯一（bad_start）', before.get('090').status === 'bad_start');
  ok('8.2 预演前 091=700 第 1、092=800 第 3（008=777 第 2）',
    before.get('091').rank === 1 && before.get('092').rank === 3);

  const r1 = await rev();
  const ops = [
    { punchId: idC002, action: 'void', reason: '申诉成立：设备重复出发' },
    { punchId: idC003, action: 'correct', reason: '申诉成立：点位秒数笔误', newPoint: 'B1', newSeconds: 500 },
    { punchId: idC004, action: 'correct', reason: '申诉成立：终点超时读数有误', newPoint: 'F', newSeconds: 650 },
  ];
  const pv = await call('/api/appeals/preview', { method: 'POST', body: JSON.stringify({ expectedRevision: r1, operations: ops }) });
  ok('8.3 预演成功并返回 token', pv.status === 200 && typeof pv.body.token === 'string');
  ok('8.3 预演只读：修订号不变', await rev() === r1);
  const stillBad = await resultsByBib();
  ok('8.3 预演不改成绩（090 仍 bad_start）', stillBad.get('090').status === 'bad_start');
  ok('8.3 预演不写审计', (await call('/api/punches?bib=090')).body.audits.length === 0);

  const am = new Map(pv.body.affected.map(x => [x.bib, x]));
  ok('8.4 受影响含直接选手 090', am.get('090')?.direct && am.get('090').changed);
  ok('8.4 090 处理后完成 650',
    am.get('090').after.status === 'ok' && am.get('090').after.elapsed === 650,
    JSON.stringify(am.get('090')?.after));
  ok('8.4 预演排名按净耗时：090 原始 650 扣停表 100 后净 550',
    am.get('090').after.netElapsed === 550 && am.get('090').after.stoppedSecs === 100);
  ok('8.4 090 处理后链为 S→A1@300→B1(C003)@500→F(C004)@650',
    JSON.stringify(am.get('090').after.chain.map(c => [c.record_no, c.point, c.seconds])) ===
    JSON.stringify([['C001', 'S', 0], ['C005', 'A1', 300], ['C003', 'B1', 500], ['C004', 'F', 650]]));
  ok('8.4 链差异纳入更正后的 C003=B1@500 与 C004=F@650',
    am.get('090').chainDiff.added.some(c => c.record_no === 'C004' && c.seconds === 650) &&
    am.get('090').chainDiff.added.some(c => c.record_no === 'C003' && c.point === 'B1'));
  ok('8.4 091 无直接操作但名次 1→2（名次联动）',
    !am.get('091').direct && am.get('091').changed &&
    am.get('091').before.rank === 1 && am.get('091').after.rank === 2);
  ok('8.4 092 无直接操作但名次 3→4（名次联动）',
    !am.get('092').direct && am.get('092').changed &&
    am.get('092').before.rank === 3 && am.get('092').after.rank === 4);
  ok('8.4 有效链未变的联动者 chainDiff 为空',
    am.get('091').chainDiff.added.length === 0 && am.get('091').chainDiff.removed.length === 0);

  // 8.5 整案校验失败路径（均不落库）
  const dup = await call('/api/appeals/preview', { method: 'POST', body: JSON.stringify({ expectedRevision: r1, operations: [
    { punchId: idC002, action: 'void', reason: 'a' },
    { punchId: idC002, action: 'void', reason: 'b' },
  ]})});
  ok('8.5 同一打卡重复指定 400', dup.status === 400 && /重复指定/.test(dup.body.error));
  // C002 此刻仍 active（预演未落库）；用缺失 id、负数秒数、空原因验证整案拒绝
  const missing = await call('/api/appeals/preview', { method: 'POST', body: JSON.stringify({ expectedRevision: r1, operations: [
    { punchId: 999999, action: 'void', reason: 'a' },
  ]})});
  ok('8.5 缺失打卡 400 整案拒绝', missing.status === 400);
  const neg = await call('/api/appeals/preview', { method: 'POST', body: JSON.stringify({ expectedRevision: r1, operations: [
    { punchId: idC003, action: 'correct', reason: 'a', newPoint: 'A1', newSeconds: -2 },
  ]})});
  ok('8.5 负数秒数 400', neg.status === 400);
  const noReason = await call('/api/appeals/preview', { method: 'POST', body: JSON.stringify({ expectedRevision: r1, operations: [
    { punchId: idC003, action: 'void', reason: '   ' },
  ]})});
  ok('8.5 缺原因 400', noReason.status === 400);
  const stalePv = await call('/api/appeals/preview', { method: 'POST', body: JSON.stringify({ expectedRevision: r1 - 1, operations: ops })});
  ok('8.5 预演过期修订 409 带 currentRevision', stalePv.status === 409 && stalePv.body.currentRevision === r1);

  // 8.6 确认：原子落库，修订只推进一次，返回最新成绩
  const cf = await call('/api/appeals/confirm', { method: 'POST', body: JSON.stringify({ expectedRevision: r1, token: pv.body.token })});
  ok('8.6 确认成功', cf.status === 200 && cf.body.ok);
  ok('8.6 修订号只推进一次', cf.body.revision === r1 + 1);
  ok('8.6 返回逐条审计数量=3', cf.body.auditCount === 3 && cf.body.committed.length === 3);
  const afterRes = new Map(cf.body.results.map(x => [x.bib, x]));
  ok('8.6 最新成绩：090=650 第1、091=700 第2、092=800 第4（008=777 第3）',
    afterRes.get('090').elapsed === 650 && afterRes.get('090').rank === 1 &&
    afterRes.get('091').rank === 2 && afterRes.get('092').rank === 4);

  const afterPunches = (await call('/api/punches?bib=090')).body;
  const c002 = afterPunches.punches.find(x => x.record_no === 'C002');
  const c003 = afterPunches.punches.find(x => x.record_no === 'C003');
  const c004 = afterPunches.punches.find(x => x.record_no === 'C004');
  ok('8.6 C002 已 voided 且带原因', c002.status === 'voided' && /设备重复出发/.test(c002.void_reason));
  ok('8.6 C003 现值 B1@500、原始 ZZ@9999 保留',
    c003.point === 'B1' && c003.seconds === 500 && c003.orig_point === 'ZZ' && c003.orig_seconds === 9999);
  ok('8.6 C004 现值 F@650、原始 F@2000 保留', c004.point === 'F' && c004.seconds === 650 && c004.orig_seconds === 2000);
  const a90 = afterPunches.audits;
  ok('8.6 三条审计一次性写入（1 void + 2 correct）',
    a90.length === 3 && a90.filter(a => a.action === 'void').length === 1 &&
    a90.filter(a => a.action === 'correct').length === 2);

  // 8.7 确认失败路径
  const reuse = await call('/api/appeals/confirm', { method: 'POST', body: JSON.stringify({ expectedRevision: r1 + 1, token: pv.body.token })});
  ok('8.7 旧 token 再确认：修订已变 409', reuse.status === 409 && reuse.body.currentRevision === r1 + 1);
  const tampered = await call('/api/appeals/confirm', { method: 'POST', body: JSON.stringify({ expectedRevision: r1 + 1, token: pv.body.token + 'x' })});
  ok('8.7 伪造 token 400', tampered.status === 400);
  const noToken = await call('/api/appeals/confirm', { method: 'POST', body: JSON.stringify({ expectedRevision: r1 + 1 })});
  ok('8.7 缺 token 400', noToken.status === 400);
  // 已作废打卡不得再进整案
  const reVoid = await call('/api/appeals/preview', { method: 'POST', body: JSON.stringify({ expectedRevision: r1 + 1, operations: [
    { punchId: idC002, action: 'void', reason: '再次作废' },
  ]})});
  ok('8.7 已作废打卡再处理 400', reVoid.status === 400 && /已作废/.test(reVoid.body.error));

  // 8.8 并发场景：预演后赛事被他人改动，旧确认必须 409 且整案不生效
  const r2 = await rev();
  const c204 = (await call('/api/punches?bib=092')).body.punches.find(x => x.record_no === 'C204');
  const pv2 = await call('/api/appeals/preview', { method: 'POST', body: JSON.stringify({ expectedRevision: r2, operations: [
    { punchId: c204.id, action: 'correct', reason: '并案：092 终点更正', newPoint: 'F', newSeconds: 750 },
  ]})});
  ok('8.8 第二次预演成功', pv2.status === 200);
  // 他人先用单条接口改了别的打卡，推进修订
  const c104 = (await call('/api/punches?bib=091')).body.punches.find(x => x.record_no === 'C104');
  await call(`/api/punches/${c104.id}/correct`, { method: 'POST', body: JSON.stringify({ reason: '他人并行操作', newPoint: 'F', newSeconds: 710 }) });
  const r3 = await rev();
  ok('8.8 他人操作后修订推进', r3 === r2 + 1);
  const staleCf = await call('/api/appeals/confirm', { method: 'POST', body: JSON.stringify({ expectedRevision: r3, token: pv2.body.token })});
  ok('8.8 旧预演确认被拒 409', staleCf.status === 409 && staleCf.body.currentRevision === r3);
  const c204After = (await call('/api/punches?bib=092')).body.punches.find(x => x.record_no === 'C204');
  ok('8.8 被拒整案未部分生效（C204 仍 800）', c204After.seconds === 800);
  // 重新预演后确认成功
  const pv3 = await call('/api/appeals/preview', { method: 'POST', body: JSON.stringify({ expectedRevision: r3, operations: [
    { punchId: c204.id, action: 'correct', reason: '并案：092 终点更正', newPoint: 'F', newSeconds: 750 },
  ]})});
  const cf3 = await call('/api/appeals/confirm', { method: 'POST', body: JSON.stringify({ expectedRevision: r3, token: pv3.body.token })});
  ok('8.8 重新预演后确认成功，修订再 +1', cf3.status === 200 && cf3.body.revision === r3 + 1);
  const c204Final = (await call('/api/punches?bib=092')).body.punches.find(x => x.record_no === 'C204');
  ok('8.8 C204 现值 750', c204Final.seconds === 750);

  // 8.9 无实际名次变化的整案：作废多余打卡，直接选手仍出现在受影响名单
  const r4 = await rev();
  // 给 092 加一条无关多余打卡再整案作废
  const addExtra = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r4, punches: [
    { recordNo: 'C299', bib: '092', point: 'ZZ', seconds: 900, kind: 'enroute' },
  ]})});
  const r5 = await rev();
  const c299 = (await call('/api/punches?bib=092')).body.punches.find(x => x.record_no === 'C299');
  const pv4 = await call('/api/appeals/preview', { method: 'POST', body: JSON.stringify({ expectedRevision: r5, operations: [
    { punchId: c299.id, action: 'void', reason: '多余读数作废' },
  ]})});
  const only = pv4.body.affected;
  ok('8.9 作废无关多余打卡：受影响仅直接选手 092', only.length === 1 && only[0].bib === '092' && only[0].direct);
  ok('8.9 直接选手成绩无变化也展示（changed=false）', only[0].changed === false && only[0].after.elapsed === 750);
  const cf4 = await call('/api/appeals/confirm', { method: 'POST', body: JSON.stringify({ expectedRevision: r5, token: pv4.body.token })});
  ok('8.9 即使成绩无变化，确认仍成功并推进修订', cf4.status === 200 && cf4.body.revision === r5 + 1);
}

console.log('9) 整案后历史发布版仍冻结');
{
  const snap1 = (await call('/api/publications/1')).body;
  ok('历史 v1 读数不受整案影响（R0003 仍 A2@300）',
    snap1.readings.find(x => x.record_no === 'R0003').point === 'A2' &&
    snap1.readings.find(x => x.record_no === 'R0003').seconds === 300);
}

console.log('10) 统一停表区间与净耗时');
{
  // 10.1 种子自带停表 500–600（与配置同事务落库，修订仍为 1）
  const ev0 = (await call('/api/event')).body;
  ok('10.1 /api/event 返回种子停表 [500,600)',
    JSON.stringify(ev0.stoppages) === JSON.stringify([{ startSecs: 500, endSecs: 600 }]));
  const rs0 = await resultsByBib();
  ok('10.1 001 原始 910 不变、停表扣 100、净耗时 810',
    rs0.get('001').elapsed === 910 && rs0.get('001').stoppedSecs === 100 && rs0.get('001').netElapsed === 810,
    JSON.stringify(rs0.get('001')));
  ok('10.1 008 在 777s 完赛，停表 [500,600) 全在其区间内：扣减 100、净 677',
    rs0.get('008').netElapsed === 677 && rs0.get('008').stoppedSecs === 100,
    JSON.stringify(rs0.get('008')));
  ok('10.1 002 终点超时未完赛：无净耗时',
    rs0.get('002').status === 'finish_dnf' && rs0.get('002').netElapsed == null && rs0.get('002').stoppedSecs == null);

  // 10.2 整案预演/确认返回净耗时字段（同一排名规则）
  const rA = await rev();
  const t100 = (await call('/api/punches?bib=100')).body.punches;
  const imp100 = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: rA, punches: [
    { recordNo: 'W1001', bib: '100', name: '停表甲', point: 'S', seconds: 0, kind: 'start' },
    { recordNo: 'W1002', bib: '100', point: 'A1', seconds: 200, kind: 'enroute' },
    { recordNo: 'W1003', bib: '100', point: 'B1', seconds: 700, kind: 'enroute' },
    { recordNo: 'W1004', bib: '100', point: 'F', seconds: 900, kind: 'finish' },
    { recordNo: 'W1011', bib: '101', name: '停表乙', point: 'S', seconds: 0, kind: 'start' },
    { recordNo: 'W1012', bib: '101', point: 'A2', seconds: 300, kind: 'enroute' },
    { recordNo: 'W1013', bib: '101', point: 'B2', seconds: 700, kind: 'enroute' },
    { recordNo: 'W1014', bib: '101', point: 'F', seconds: 950, kind: 'finish' },
  ]})});
  ok('10.2 导入 100/101 八条读数', imp100.status === 200 && imp100.body.inserted === 8);

  // 10.3 无效区间整次拒绝（不写库、不推进修订）
  const rB = await rev();
  const neg = await call('/api/stoppages', { method: 'POST', body: JSON.stringify({ expectedRevision: rB, stoppages: [
    { startSecs: 100, endSecs: -5 },
  ]})});
  ok('10.3 负秒数 400 整次拒绝', neg.status === 400 && /非负整数|不能为负/.test(neg.body.error));
  const ge = await call('/api/stoppages', { method: 'POST', body: JSON.stringify({ expectedRevision: rB, stoppages: [
    { startSecs: 300, endSecs: 300 },
  ]})});
  ok('10.3 起点等于终点 400', ge.status === 400 && /起点/.test(ge.body.error));
  const badType = await call('/api/stoppages', { method: 'POST', body: JSON.stringify({ expectedRevision: rB, stoppages: [
    { startSecs: '100', endSecs: 200 },
  ]})});
  ok('10.3 非整数 400', badType.status === 400);
  const mixed = await call('/api/stoppages', { method: 'POST', body: JSON.stringify({ expectedRevision: rB, stoppages: [
    { startSecs: 0, endSecs: 100 },
    { startSecs: 50, endSecs: 40 },
  ]})});
  ok('10.3 混有非法区间：整次拒绝、不落库', mixed.status === 400 && (await call('/api/stoppages')).body.stoppages.length === 1);
  const stale = await call('/api/stoppages', { method: 'POST', body: JSON.stringify({ expectedRevision: rB + 999, stoppages: [] })});
  ok('10.3 过期修订 409 带 currentRevision', stale.status === 409 && stale.body.currentRevision === rB);

  // 10.4 无变化保存不推进修订；重叠区间合并存储
  const noop = await call('/api/stoppages', { method: 'POST', body: JSON.stringify({ expectedRevision: rB, stoppages: [
    { startSecs: 500, endSecs: 600 },
  ]})});
  ok('10.4 相同区间无变化保存：200 且修订不变', noop.status === 200 && noop.body.changed === false && noop.body.revision === rB);
  const overlap = await call('/api/stoppages', { method: 'POST', body: JSON.stringify({ expectedRevision: rB, stoppages: [
    { startSecs: 400, endSecs: 550 },   // 与相邻区间交叠
    { startSecs: 550, endSecs: 700 },   // 相邻也合并
    { startSecs: 900, endSecs: 950 },
  ]})});
  ok('10.4 重叠/相邻区间合并为 [400,700) 与 [900,950)，修订 +1',
    overlap.status === 200 && overlap.body.changed === true && overlap.body.revision === rB + 1 &&
    JSON.stringify(overlap.body.stoppages) ===
      JSON.stringify([{ startSecs: 400, endSecs: 700 }, { startSecs: 900, endSecs: 950 }]),
    JSON.stringify(overlap.body.stoppages));

  // 10.5 净耗时与并列排名
  const rs1 = await resultsByBib();
  // 100：原始 900，停表交 [400,700)=300、[900,950)∩[0,900]=0 → 净 600
  // 101：原始 950，交长 300+50=350 → 净 600；两人净耗时并列
  ok('10.5 100 原始 900 扣 300 净 600',
    rs1.get('100').elapsed === 900 && rs1.get('100').stoppedSecs === 300 && rs1.get('100').netElapsed === 600);
  ok('10.5 101 原始 950 扣 350 净 600',
    rs1.get('101').elapsed === 950 && rs1.get('101').stoppedSecs === 350 && rs1.get('101').netElapsed === 600);
  ok('10.5 100/101 净耗时并列同名次', rs1.get('100').rank === rs1.get('101').rank);
  // 008=777 与 [400,700) 交长 300 → 净 477，仍快于并列者
  ok('10.5 008 原始 777 扣 300 净 477，名次在并列者之前',
    rs1.get('008').netElapsed === 477 && rs1.get('008').stoppedSecs === 300 && rs1.get('008').rank < rs1.get('100').rank);

  // 10.6 发布冻结当时停表与净耗时，之后调整不改历史版
  const rC = await rev();
  const pub = await call('/api/publications', { method: 'POST', body: JSON.stringify({ expectedRevision: rC, note: '停表冻结版' }) });
  ok('10.6 发布成功', pub.status === 200);
  const vStop = pub.body.version;
  const snap = (await call(`/api/publications/${vStop}`)).body;
  ok('10.6 快照冻结停表区间',
    JSON.stringify(snap.stoppages) ===
      JSON.stringify([{ startSecs: 400, endSecs: 700 }, { startSecs: 900, endSecs: 950 }]));
  const s101 = snap.results.find(x => x.bib === '101');
  ok('10.6 快照成绩同时含原始 950 与净耗时 600', s101.elapsed === 950 && s101.netElapsed === 600);
  const sDNF = snap.results.find(x => x.bib === '002');
  ok('10.6 未完赛者冻结成绩无净耗时', sDNF.netElapsed == null && sDNF.elapsed == null);

  // 清空停表区间（有效变更）并再发布一版
  const rD = await rev();
  const cleared = await call('/api/stoppages', { method: 'POST', body: JSON.stringify({ expectedRevision: rD, stoppages: [] })});
  ok('10.7 清空区间成功并推进修订', cleared.status === 200 && cleared.body.stoppages.length === 0 && cleared.body.revision === rD + 1);
  const rs2 = await resultsByBib();
  ok('10.7 清空后净耗时=原始耗时（100=900）', rs2.get('100').netElapsed === 900 && rs2.get('100').stoppedSecs === 0);
  const rE = await rev();
  const pub2 = await call('/api/publications', { method: 'POST', body: JSON.stringify({ expectedRevision: rE, note: '无停表版' })});
  const oldSnap = (await call(`/api/publications/${vStop}`)).body;
  ok('10.7 历史版仍冻结旧停表区间与净耗时（101 净 600）',
    oldSnap.stoppages.length === 2 && oldSnap.results.find(x => x.bib === '101').netElapsed === 600);
  const newSnap = (await call(`/api/publications/${pub2.body.version}`)).body;
  ok('10.7 新版停表为空、净耗时=原始（101=950）',
    newSnap.stoppages.length === 0 && newSnap.results.find(x => x.bib === '101').netElapsed === 950);
}

console.log('11) 组别赛道与组内名次');
{
  // 11.1 种子组别赛道与归属（与配置同事务落库）
  const dv = (await call('/api/divisions')).body;
  ok('11.1 种子含 ELITE/FUN 两个组别赛道',
    dv.divisions.length === 2 && dv.divisions[0].code === 'ELITE' && dv.divisions[1].code === 'FUN');
  ok('11.1 精英组终点截止 1500、体验组 1200（覆盖赛事 1800）',
    dv.divisions[0].finishCutoff === 1500 && dv.divisions[1].finishCutoff === 1200);
  ok('11.1 体验组赛道仅一组、替代点位 C1/C2',
    JSON.stringify(dv.divisions[1].groups.map(g => g.points)) === JSON.stringify([['C1', 'C2']]));
  ok('11.1 归属 5 人（001/004/006→ELITE，201/202→FUN）',
    dv.assignments.length === 5 && dv.assignments.some(a => a.bib === '201' && a.division === 'FUN'));
  const ev11 = (await call('/api/event')).body;
  ok('11.1 /api/event 同步返回组别与归属', ev11.divisions.length === 2 && ev11.assignments.length === 5);

  const rs1 = await resultsByBib();
  ok('11.1 001 属 ELITE：组内第 1（全场第 6）',
    rs1.get('001').division === 'ELITE' && rs1.get('001').groupRank === 1 && rs1.get('001').rank === 6,
    JSON.stringify({ rank: rs1.get('001').rank, groupRank: rs1.get('001').groupRank }));
  ok('11.1 004/006 同净耗时并列组内第 2',
    rs1.get('004').groupRank === 2 && rs1.get('006').groupRank === 2);
  ok('11.1 201/202 按体验组赛道完赛：组内 1/2（全场 11/12）',
    rs1.get('201').division === 'FUN' && rs1.get('201').groupRank === 1 && rs1.get('201').rank === 11 &&
    rs1.get('202').groupRank === 2 && rs1.get('202').rank === 12);
  ok('11.1 未分组者同属默认赛道组：090 组内第 1（全场第 1）',
    rs1.get('090').division === null && rs1.get('090').groupRank === 1 && rs1.get('090').rank === 1);
  ok('11.1 未完赛者两种名次均为空（002 终点超时 / 080 组未完成）',
    rs1.get('002').rank == null && rs1.get('002').groupRank == null &&
    rs1.get('080').rank == null && rs1.get('080').groupRank == null);

  // 11.2 整次拒绝（均不落库、不推进修订）
  const r0 = await rev();
  const baseDivisions = dv.divisions;
  const baseAssignments = dv.assignments;
  const post = (payload) => call('/api/divisions', { method: 'POST', body: JSON.stringify(payload) });
  const unknownDiv = await post({ expectedRevision: r0, divisions: baseDivisions, assignments: [{ bib: '008', division: 'NOPE' }] });
  ok('11.2 未知组别 400 整次拒绝', unknownDiv.status === 400 && /不存在/.test(unknownDiv.body.error));
  const dupBib = await post({ expectedRevision: r0, divisions: baseDivisions,
    assignments: [...baseAssignments, { bib: '008', division: 'ELITE' }, { bib: '008', division: 'FUN' }] });
  ok('11.2 重复归属 400 整次拒绝', dupBib.status === 400 && /重复指定/.test(dupBib.body.error));
  const emptyPts = await post({ expectedRevision: r0,
    divisions: [{ code: 'X', name: '测试', groups: [{ name: 'g', points: [] }] }], assignments: [] });
  ok('11.2 空替代点位 400 整次拒绝', emptyPts.status === 400 && /替代点位/.test(emptyPts.body.error));
  const dupCode = await post({ expectedRevision: r0, divisions: [
    { code: 'X', name: 'a', groups: [{ name: 'g', points: ['P1'] }] },
    { code: 'X', name: 'b', groups: [{ name: 'g', points: ['P2'] }] },
  ], assignments: [] });
  ok('11.2 组别代码重复 400', dupCode.status === 400 && /重复/.test(dupCode.body.error));
  const startPt = await post({ expectedRevision: r0,
    divisions: [{ code: 'X', name: 'a', groups: [{ name: 'g', points: ['S'] }] }], assignments: [] });
  ok('11.2 点位与起点相同 400', startPt.status === 400 && /起点/.test(startPt.body.error));
  const unknownBib = await post({ expectedRevision: r0, divisions: baseDivisions,
    assignments: [{ bib: '999', division: 'ELITE' }] });
  ok('11.2 未知号码布 400', unknownBib.status === 400 && /999/.test(unknownBib.body.error));
  const stale = await post({ expectedRevision: r0 + 999, divisions: [], assignments: [] });
  ok('11.2 过期修订 409 带 currentRevision', stale.status === 409 && stale.body.currentRevision === r0);
  ok('11.2 整次拒绝后修订号与配置不变',
    (await rev()) === r0 && (await call('/api/divisions')).body.assignments.length === 5);
  const noop = await post({ expectedRevision: r0, divisions: baseDivisions, assignments: baseAssignments });
  ok('11.2 提交内容与现状相同：只读，不推进修订',
    noop.status === 200 && noop.body.changed === false && noop.body.revision === r0);

  // 11.3 归属变更原子生效并推动实时重算：008 分入 ELITE
  const a1 = await post({ expectedRevision: r0, divisions: baseDivisions,
    assignments: [...baseAssignments, { bib: '008', division: 'ELITE' }] });
  ok('11.3 归属变更成功且修订 +1', a1.status === 200 && a1.body.changed === true && a1.body.revision === r0 + 1);
  const rs2 = await resultsByBib();
  ok('11.3 008 按精英组赛道完赛（777≤1500）并成为组内第 1',
    rs2.get('008').division === 'ELITE' && rs2.get('008').status === 'ok' && rs2.get('008').groupRank === 1);
  ok('11.3 ELITE 组内名次联动：001 退至组内第 2，004/006 并列第 3',
    rs2.get('001').groupRank === 2 && rs2.get('004').groupRank === 3 && rs2.get('006').groupRank === 3);
  ok('11.3 全场名次不受归属影响（008 仍全场第 4）', rs2.get('008').rank === 4);

  // 11.4 组别/归属变更使整案预演令牌过期（确认 409，需重新预演）
  const r1 = await rev();
  const p090 = (await call('/api/punches?bib=090')).body.punches.find(x => x.record_no === 'C005');
  const pv = await call('/api/appeals/preview', { method: 'POST', body: JSON.stringify({ expectedRevision: r1, operations: [
    { punchId: p090.id, action: 'correct', reason: '测试组别变更联动', newPoint: 'A1', newSeconds: 310 },
  ]})});
  ok('11.4 整案预演成功', pv.status === 200 && typeof pv.body.token === 'string');
  const un = await post({ expectedRevision: r1, divisions: baseDivisions, assignments: baseAssignments });
  ok('11.4 他人把 008 移回未分组：修订再 +1', un.status === 200 && un.body.revision === r1 + 1);
  const staleCf = await call('/api/appeals/confirm', { method: 'POST', body: JSON.stringify({ expectedRevision: r1 + 1, token: pv.body.token }) });
  ok('11.4 旧预演确认 409 并返回当前修订', staleCf.status === 409 && staleCf.body.currentRevision === r1 + 1);
  const p090After = (await call('/api/punches?bib=090')).body.punches.find(x => x.record_no === 'C005');
  ok('11.4 被拒整案未部分生效（C005 仍 A1@300）', p090After.point === 'A1' && p090After.seconds === 300);

  // 11.5 发布冻结组别赛道、归属与两种名次；后续变更不改历史
  const r2 = await rev();
  const pub = await call('/api/publications', { method: 'POST', body: JSON.stringify({ expectedRevision: r2, note: '组别冻结版' }) });
  ok('11.5 发布成功', pub.status === 200);
  const vDiv = pub.body.version;
  const snap = (await call(`/api/publications/${vDiv}`)).body;
  ok('11.5 快照冻结组别赛道与归属（008 已移回，共 5 条归属）',
    snap.divisions.length === 2 && snap.assignments.length === 5 &&
    snap.assignments.every(a => a.bib !== '008'));
  const s001 = snap.results.find(x => x.bib === '001');
  const s201 = snap.results.find(x => x.bib === '201');
  ok('11.5 快照成绩含两种名次（001 全场第 6 / ELITE 组内第 1）',
    s001.division === 'ELITE' && s001.rank === 6 && s001.groupRank === 1);
  ok('11.5 快照 201 体验组组内第 1', s201.division === 'FUN' && s201.groupRank === 1);

  // 清空全部组别（有效变更）：所有完赛者落入默认赛道组，组内名次=全场名次
  const r3 = await rev();
  const cleared = await post({ expectedRevision: r3, divisions: [], assignments: [] });
  ok('11.5 清空组别成功并推进修订', cleared.status === 200 && cleared.body.revision === r3 + 1);
  const rs3 = await resultsByBib();
  ok('11.5 清空后 001 回到默认赛道，组内名次=全场名次',
    rs3.get('001').division === null && rs3.get('001').groupRank === rs3.get('001').rank);
  const snapAgain = (await call(`/api/publications/${vDiv}`)).body;
  const s001b = snapAgain.results.find(x => x.bib === '001');
  ok('11.5 历史版仍冻结组别与组内名次（001 仍 ELITE 组内第 1）',
    snapAgain.divisions.length === 2 && s001b.division === 'ELITE' && s001b.groupRank === 1);

  // 11.6 选手按所属赛道构造有效链：同一选手换组后按新赛道判定
  const r4 = await rev();
  await post({ expectedRevision: r4, divisions: baseDivisions, assignments: baseAssignments });
  const r5 = await rev();
  const move5 = await post({ expectedRevision: r5, divisions: baseDivisions,
    assignments: [...baseAssignments, { bib: '005', division: 'FUN' }] });
  ok('11.6 005 改分体验组', move5.status === 200);
  const rs4 = await resultsByBib();
  ok('11.6 005 按体验组赛道判定：无 C1/C2 打卡 → 组未完成于「体验组」，两种名次为空',
    rs4.get('005').division === 'FUN' && rs4.get('005').status === 'group_dnf' &&
    rs4.get('005').failAt === '体验组' && rs4.get('005').rank == null && rs4.get('005').groupRank == null);
  const r6 = await rev();
  await post({ expectedRevision: r6, divisions: baseDivisions, assignments: baseAssignments });
  const rs5 = await resultsByBib();
  ok('11.6 005 移回未分组后按默认赛道完赛（980）',
    rs5.get('005').status === 'ok' && rs5.get('005').elapsed === 980);

  // 11.7 组别终点截止覆盖赛事值：002 在放宽截止的长距离组中完赛（1850≤1900）
  const r7 = await rev();
  const longDiv = [...baseDivisions, { code: 'LONG', name: '长距离组', finishCutoff: 1900,
    groups: [
      { name: '北山组', cutoffSecs: 600, points: ['A1', 'A2'] },
      { name: '湖畔组', cutoffSecs: 1200, points: ['B1', 'B2'] },
    ] }];
  const move2 = await post({ expectedRevision: r7, divisions: longDiv,
    assignments: [...baseAssignments, { bib: '002', division: 'LONG' }] });
  ok('11.7 002 分入长距离组（组别终点截止 1900）', move2.status === 200);
  const rs6 = await resultsByBib();
  ok('11.7 002 按组别终点截止完赛（1850≤1900；赛事截止 1800 下原本超时），组内第 1',
    rs6.get('002').status === 'ok' && rs6.get('002').elapsed === 1850 && rs6.get('002').groupRank === 1);
  const r8 = await rev();
  await post({ expectedRevision: r8, divisions: baseDivisions, assignments: baseAssignments });
  const rs7 = await resultsByBib();
  ok('11.7 移回未分组后 002 恢复终点超时', rs7.get('002').status === 'finish_dnf' && rs7.get('002').rank == null);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
