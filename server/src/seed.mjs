// 首次启动时可选地写入演示赛事（SEED=1 时生效）。
import { bumpRevision } from './db.mjs';

export function seedDemo(db) {
  if (db.prepare('SELECT v FROM meta WHERE k = ?').get('seeded')) return false;
  if (!db.prepare('SELECT 1 FROM event WHERE id = 1').get()) {
    // 赛事：起点 S，终点 F，终点截止 1800s；两组顺序关卡，各含可替代点位
    db.prepare(
      `INSERT INTO event (id, name, start_point, finish_point, finish_cutoff, revision)
       VALUES (1, ?, 'S', 'F', 1800, 0)`
    ).run('2026 秋季定向越野挑战赛');

    const g1 = db
      .prepare('INSERT INTO checkpoint_group (seq, name, cutoff_secs) VALUES (1, ?, 600)')
      .run('北山组').lastInsertRowid;
    const g2 = db
      .prepare('INSERT INTO checkpoint_group (seq, name, cutoff_secs) VALUES (2, ?, 1200)')
      .run('湖畔组').lastInsertRowid;
    const insPt = db.prepare('INSERT INTO group_point (group_id, point, seq) VALUES (?, ?, ?)');
    insPt.run(g1, 'A1', 1); insPt.run(g1, 'A2', 2);
    insPt.run(g2, 'B1', 1); insPt.run(g2, 'B2', 2);

    // 天气原因统一停表：距发枪 500s–600s（重叠区间只计一次；净耗时排名时扣减）
    const insStop = db.prepare('INSERT INTO stoppage_interval (start_secs, end_secs) VALUES (?, ?)');
    insStop.run(500, 600);

    // 组别赛道（本轮新增演示）：同场赛事下不同参赛组别各有自己的有序关卡与截止
    //  - ELITE 精英组：与默认赛道同点位，但终点截止更严（1500s）
    //  - FUN   体验组：只过「体验组」{C1,C2}（≤900s），终点截止 1200s
    // 未指定组别的选手（002/003/005）沿用上方默认赛道
    const insDiv = db.prepare('INSERT INTO division (code, name, finish_cutoff, seq) VALUES (?, ?, ?, ?)');
    const insDG = db.prepare('INSERT INTO division_group (division_id, seq, name, cutoff_secs) VALUES (?, ?, ?, ?)');
    const insDGP = db.prepare('INSERT INTO division_group_point (group_id, point, seq) VALUES (?, ?, ?)');
    const elite = insDiv.run('ELITE', '精英组', 1500, 1).lastInsertRowid;
    const eg1 = insDG.run(elite, 1, '北山组', 600).lastInsertRowid;
    const eg2 = insDG.run(elite, 2, '湖畔组', 1200).lastInsertRowid;
    insDGP.run(eg1, 'A1', 1); insDGP.run(eg1, 'A2', 2);
    insDGP.run(eg2, 'B1', 1); insDGP.run(eg2, 'B2', 2);
    const fun = insDiv.run('FUN', '体验组', 1200, 2).lastInsertRowid;
    const fg1 = insDG.run(fun, 1, '体验组', 900).lastInsertRowid;
    insDGP.run(fg1, 'C1', 1); insDGP.run(fg1, 'C2', 2);

    const insRunner = db.prepare('INSERT INTO runner (bib, name) VALUES (?, ?)');
    insRunner.run('001', '张明'); insRunner.run('002', '李华');
    insRunner.run('003', '王芳'); insRunner.run('004', '赵强');
    insRunner.run('005', '陈晨'); insRunner.run('006', '孙磊');
    insRunner.run('201', '刘洋'); insRunner.run('202', '周敏');

    // 号码布归属：001/004/006 精英组，201/202 体验组；002/003/005 未分组（默认赛道）
    const insAssign = db.prepare('INSERT INTO runner_division (bib, division_id) VALUES (?, ?)');
    insAssign.run('001', elite); insAssign.run('004', elite); insAssign.run('006', elite);
    insAssign.run('201', fun); insAssign.run('202', fun);

    // record_no 全局唯一；kind: start | enroute | finish
    // 首次入库时现值即原始读数，orig_* 同步落库
    const insP = db.prepare(
      `INSERT INTO punch (record_no, bib, point, seconds, kind, orig_bib, orig_point, orig_seconds, orig_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const rows = [
      // 001 张明：正常完成 910s（多余的逆序打卡 A2 不作依据）
      ['R0001','001','S',0,'start'], ['R0002','001','X',120,'enroute'],
      ['R0003','001','A2',300,'enroute'], ['R0004','001','B1',700,'enroute'],
      ['R0005','001','A1',820,'enroute'], ['R0006','001','F',910,'finish'],
      // 002 李华：终点超时
      ['R0010','002','S',0,'start'], ['R0011','002','A1',200,'enroute'],
      ['R0012','002','B2',900,'enroute'], ['R0013','002','F',1850,'finish'],
      // 003 王芳：第二组未完成（组截止前未到 B1/B2）
      ['R0020','003','S',0,'start'], ['R0021','003','A1',250,'enroute'],
      ['R0022','003','B1',1250,'enroute'], ['R0023','003','F',1500,'finish'],
      // 004 赵强：与 006 同耗时 1000s 并列；途中含一条明显错误读数待裁判处理
      ['R0030','004','S',0,'start'], ['R0031','004','A1',400,'enroute'],
      ['R0032','004','ZZ',99999,'enroute'], ['R0033','004','B2',720,'enroute'],
      ['R0034','004','F',1000,'finish'],
      // 005 陈晨：出发打卡重复（争议待核）
      ['R0040','005','S',0,'start'], ['R0041','005','S',5,'start'],
      ['R0042','005','A2',350,'enroute'], ['R0043','005','B1',800,'enroute'],
      ['R0044','005','F',980,'finish'],
      // 006 孙磊：与 004 同耗时并列
      ['R0050','006','S',0,'start'], ['R0051','006','A2',400,'enroute'],
      ['R0052','006','B1',700,'enroute'], ['R0053','006','F',1000,'finish'],
      // 201 刘洋（体验组）：C1@400 → F@1150，原始 1150、净 1050（追加在末尾，保持既有记录 id 不变）
      ['R0201','201','S',0,'start'], ['R0202','201','C1',400,'enroute'],
      ['R0203','201','F',1150,'finish'],
      // 202 周敏（体验组）：C2@450 → F@1200（恰在组别终点截止），原始 1200、净 1100
      ['R0204','202','S',0,'start'], ['R0205','202','C2',450,'enroute'],
      ['R0206','202','F',1200,'finish'],
    ];
    const tx = db.transaction(() => {
      for (const r of rows) insP.run(r[0], r[1], r[2], r[3], r[4], r[1], r[2], r[3], r[4]);
      // 关卡初始为修订 #1，演示读数导入后推进
      bumpRevision(db);
      db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('seeded', '1');
    });
    tx();
  }
  return true;
}
