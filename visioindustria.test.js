'use strict';
/*
 * Testes automatizados do VisioIndústria (Node >= 18, sem dependências):   node --test testes/
 * Extraem trechos do próprio HTML (marcadores "==== ... ====") e rodam o script completo com câmera, voz e modelo SIMULADOS (stubs).
 * IMPORTANTE: os tempos e as detecções destes testes são sintéticos. Eles validam a LÓGICA (concorrência, contadores, erros, mensagens),
 * não a câmera real, a precisão do COCO-SSD nem o desempenho em celular.
 */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const HTML = process.env.VISIO_HTML || path.join(__dirname, '..', 'visioindustria.html');
const SC = fs.readFileSync(HTML, 'utf8').split('<script>')[1].split('</script>')[0];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const bloco = (a, b) => { const i = SC.indexOf(a), j = SC.indexOf(b); assert.ok(i >= 0 && j > i, 'marcador não encontrado: ' + a); return SC.slice(i, j); };
const { criarAgendador } = new Function(bloco('function criarAgendador', '// ==== FIM AGENDADOR') + ';return {criarAgendador}')();
const P = new Function(bloco('const CLASSES', '// ==== FIM CLASSES') + bloco('const ZTXT', '// ==== FIM PLANEJADOR') + ';return {planejar,planejarSemObjetos,zonaDe,atualizarTracks,CLASSES,decidirOrientacao,criarEstabilizadorAlt,resolverLados,rotulosLados,avaliarPassagemPorCor,MSG}')();

// ---------- agendador (unidade) ----------
// Relógio controlado: now() avança só quando a tarefa ou o agendador "gastam" tempo; timers reais com 0 ms.
function relogio(){ let t = 0; return {now: () => t, avanca: ms => { t += ms; }, setTimer: (f, ms) => { t += ms; return setTimeout(f, 0); }, clearTimer: clearTimeout, setWatch: (f, ms) => setTimeout(f, ms), clearWatch: clearTimeout}; }
const base = (r, extra = {}) => Object.assign({now: r.now, setTimer: r.setTimer, clearTimer: r.clearTimer, setWatch: r.setWatch, clearWatch: r.clearWatch, intervalo: () => 100, folgaMin: 30, folgaIgnorado: 20, stallMs: 1000, watchdogMs: 5000}, extra);
const ate = async (cond, ms = 3000) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await sleep(2); assert.ok(cond(), 'condição não atingida a tempo'); };

test('agendador: mede inferência, ciclo total e FPS efetivo com relógio controlado', async () => {
  const r = relogio(), ag = criarAgendador(base(r));
  ag.registrar({nome: 'm', executar: async () => { r.avanca(50); return 1; }, aoConcluir: () => r.avanca(10)});
  ag.iniciar(); await ate(() => ag.snapshot().concluidos >= 40);
  const s = ag.snapshot(r.now()); ag.parar();
  assert.equal(s.tarefas.m.media, 50); assert.equal(s.tarefas.m.p95, 50);
  assert.equal(s.ciclo.media, 60);                                   // 50 inferência + 10 alertas/desenho
  assert.ok(s.fpsEfetivo > 9 && s.fpsEfetivo < 11, 'fps ' + s.fpsEfetivo); // período 60 + espera 40 = 100 ms → 10/s
  assert.equal(s.erros, 0); assert.equal(s.acimaIntervalo, 0);
});

test('agendador: duas tarefas nunca rodam ao mesmo tempo; cadaN reduz a frequência da segunda', async () => {
  let em = 0, max = 0, a = 0, b = 0;
  const gasta = async () => { em++; max = Math.max(max, em); await sleep(4); em--; };
  const ag = criarAgendador({now: () => performance.now(), setTimer: setTimeout, clearTimer: clearTimeout, intervalo: () => 10});
  ag.registrar({nome: 'a', prio: 1, executar: async () => { await gasta(); a++; }});
  ag.registrar({nome: 'b', prio: 2, cadaN: 3, executar: async () => { await gasta(); b++; }});
  ag.iniciar(); await ate(() => a >= 30, 8000); ag.parar();
  assert.equal(max, 1); assert.ok(Math.abs(b - a / 3) <= 1.5, `a=${a} b=${b}`);   // cadaN=3 é por número de ciclo: independe da velocidade da máquina
});

test('agendador: pausar/retomar repetidos não duplicam a cadeia nem a concorrência', async () => {
  let em = 0, max = 0, calls = 0; const inicios = [];
  const ag = criarAgendador({now: () => performance.now(), setTimer: setTimeout, clearTimer: clearTimeout, intervalo: () => 40});
  ag.registrar({nome: 'm', executar: async () => { inicios.push(performance.now()); em++; max = Math.max(max, em); calls++; await sleep(15); em--; }});
  ag.iniciar(); await sleep(250); let c0 = calls; await sleep(600); const antes = calls - c0;
  for (let i = 0; i < 60; i++){ ag.pausar(); await sleep(Math.random() * 30); ag.retomar(); await sleep(Math.random() * 30); }
  await sleep(300); c0 = calls; const i0 = inicios.length; await sleep(600); const depois = calls - c0; ag.parar();
  assert.equal(max, 1); assert.ok(depois <= antes * 1.25 + 1, `antes=${antes} depois=${depois}`);
  // com UMA cadeia, o espaçamento entre inícios nunca fica abaixo do intervalo (40 ms); cadeia duplicada o viola
  const esp = inicios.slice(i0).map((t, k, a) => k ? t - a[k-1] : Infinity).slice(1);
  assert.ok(Math.min(...esp) >= 36, 'espaçamento mínimo ' + Math.min(...esp).toFixed(1) + ' ms');
});

test('agendador: resultado obsoleto (pausa durante a inferência) é descartado', async () => {
  let concluiu = 0; const ag = criarAgendador({now: () => performance.now(), setTimer: setTimeout, clearTimer: clearTimeout, intervalo: () => 20});
  ag.registrar({nome: 'm', executar: async () => { await sleep(80); return 1; }, aoConcluir: () => concluiu++});
  ag.iniciar(); await sleep(30); ag.pausar(); await sleep(150);
  assert.equal(concluiu, 0); assert.equal(ag.snapshot().descartados, 1); assert.equal(ag.snapshot().concluidos, 0); ag.parar();
});

test('agendador: erro na tarefa ou em aoConcluir é contado e não prende o agendador', async () => {
  const r = relogio(); let falhas = 0, erros = [], k = 0;
  const ag = criarAgendador(base(r, {aoErro: e => erros.push(e.message)}));
  ag.registrar({nome: 'm', executar: async () => { if (++k <= 3) throw new Error('boom ' + k); return k; }, aoConcluir: v => { if (v === 5) throw new Error('falha no callback'); }});
  ag.iniciar(); await ate(() => ag.snapshot().concluidos >= 5);
  const s = ag.snapshot(); ag.parar();
  assert.equal(s.erros, 4); assert.deepEqual(erros.slice(0, 3), ['boom 1', 'boom 2', 'boom 3']); assert.equal(erros[3], 'falha no callback');
});

test('agendador: sem quadro novo → ciclo ignorado; passando de stallMs vira erro; recupera quando o quadro volta', async () => {
  const r = relogio(); let semQuadro = true, rodou = 0, erros = [];
  const ag = criarAgendador(base(r, {verificar: () => semQuadro ? {ignorar: 'sem_quadro_novo'} : {}, aoErro: e => erros.push(e.message)}));
  ag.registrar({nome: 'm', executar: async () => { rodou++; r.avanca(5); }});
  ag.iniciar(); await ate(() => erros.length >= 2);
  assert.equal(rodou, 0); assert.ok(ag.snapshot().motivos.sem_quadro_novo > 10); assert.match(erros[0], /Sem quadros novos/);
  semQuadro = false; await ate(() => ag.snapshot().concluidos >= 3); ag.parar();
  assert.ok(rodou >= 3);
});

test('agendador: aparelho lento não acumula trabalho; opcional é adiada', async () => {
  const r = relogio(); let opc = 0;
  const ag = criarAgendador(base(r, {intervalo: () => 20}));
  ag.registrar({nome: 'm', prio: 1, executar: async () => { r.avanca(60); }});
  ag.registrar({nome: 'x', prio: 2, opcional: true, executar: async () => { opc++; }});
  ag.iniciar(); await ate(() => ag.snapshot().concluidos >= 10); const s = ag.snapshot(); ag.parar();
  assert.equal(opc, 1);                                              // só no 1º ciclo, antes de o ciclo lento ser medido
  assert.ok(s.tarefas.x.adiadas >= 8); assert.equal(s.acimaIntervalo, s.concluidos);
});

test('agendador: watchdog abandona inferência travada e recomeça', async () => {
  let k = 0, erros = [], ok = 0;
  const ag = criarAgendador({now: () => performance.now(), setTimer: setTimeout, clearTimer: clearTimeout, intervalo: () => 20, watchdogMs: 80, aoErro: e => erros.push(e.message)});
  ag.registrar({nome: 'm', executar: () => ++k === 1 ? new Promise(() => {}) : Promise.resolve(1), aoConcluir: () => ok++});
  ag.iniciar(); await ate(() => ok >= 3, 1500); ag.parar();
  assert.equal(erros.length, 1); assert.match(erros[0], /travada/);
});

// ---------- planejador / estabilização (lógica pura) ----------
const grupo = (cls, z, n, area) => ({cls, info: P.CLASSES[cls], z, n, area});
test('planejador: mensagens e proibição de afirmar passagem livre', () => {
  const W = 640, H = 480, B = (cx, w, h) => [cx*W - w*W/2, 100, w*W, h*H];
  const g = (cls, cx, w, h, n = 1) => { const b = B(cx, w, h); return {cls, info: P.CLASSES[cls], z: P.zonaDe(b, W), n, area: b[2]*b[3]/(W*H)}; };
  const dizer = gs => P.planejar(gs).texto;
  assert.equal(dizer([g('chair', .15, .2, .3)]), 'Cadeira à esquerda.');
  assert.equal(dizer([g('person', .85, .15, .5), g('chair', .15, .2, .3)]), 'Pessoa à direita e cadeira à esquerda. Não foi possível confirmar uma passagem.');
  assert.equal(dizer([g('dining table', .2, .2, .2), g('chair', .15, .15, .3)]), 'Cadeira e mesa à esquerda.');
  assert.equal(dizer([g('person', .5, .15, .5), g('chair', .15, .2, .3)]), 'Pessoa à frente e cadeira à esquerda. Não foi possível confirmar uma passagem.');
  assert.match(dizer([g('dining table', .5, .9, .6)]), /^Mesa à frente\. Não foi possível confirmar uma passagem\.$/);
  for (const t of [dizer([g('person', .5, .2, .6), g('chair', .5, .3, .3)]), dizer([g('person', .5, .15, .5), g('chair', .15, .15, .3, 2), g('dining table', .85, .2, .2), g('bicycle', .9, .1, .2), g('backpack', .3, .05, .05)])]){
    assert.doesNotMatch(t, /caminho (seguro|livre)|pode seguir/i); assert.doesNotMatch(t, /passagem livre/i);
  }
});
test('estabilização: tolera 1 ciclo perdido, desativa após 3 ausências e não oscila a contagem', () => {
  const tr = new Map(), em = (n) => new Map(n ? [['cadeira|esquerda', grupo('chair', 'esquerda', n, .05)]] : []);
  const passo = (n) => P.atualizarTracks(tr, em(n), 2);
  assert.equal(passo(1).length, 0);                                  // 1ª presença: ainda não é estável (persist = 2)
  assert.equal(passo(1).length, 1);                                  // 2ª presença: ativa
  assert.equal(passo(0).length, 1); assert.equal(passo(0).length, 1); // 1 e 2 ausências: continua ativa
  assert.equal(passo(0).length, 0);                                  // 3ª ausência: desativa
  const tr2 = new Map(); const p2 = n => P.atualizarTracks(tr2, em(n), 2);
  p2(1); p2(1); const lidas = []; for (let i = 0; i < 12; i++) lidas.push(p2(i % 2 ? 2 : 1)[0].n);
  assert.ok(new Set(lidas).size === 1, 'contagem oscilou: ' + lidas);
});

// ---------- script completo com stubs ----------
async function montar({script = [[]], detectMs = 8, vals = {}, rvfcMs = null, loadMs = 0, loadFalha = false, detectFalha = false, facing = '', quadro = null} = {}){
  const v = Object.assign({conf: 60, persist: 2, intervalo: 20, cool: 30, modelo: 'lite_mobilenet_v2', camSel: '', passagem: 'desligada', modo: 'padrao'}, vals), els = {};
  const mk = id => els[id] || (els[id] = {id, value: v[id] ?? '', textContent: '', title: '', style: {}, children: [], disabled: false, addEventListener(){}, prepend(){}, lastChild: {remove(){}},
    getContext: () => new Proxy({}, {get: (t, k) => k === 'measureText' ? () => ({width: 10}) : () => {}, set: () => true})});
  let api; const win = {speechSynthesis: null}; const falas = []; let cancels = 0, i = 0, em = 0, maxEm = 0, calls = 0;
  const ss = {getVoices: () => [], speaking: false, speak: u => falas.push(u.t), cancel(){ cancels++; }};
  const stream = {active: true, getTracks: () => [{stop(){}}], getVideoTracks: () => [{addEventListener(){}, getSettings: () => facing ? ({facingMode: facing}) : ({})}]};
  const video = mk('video'); Object.assign(video, {readyState: 2, videoWidth: 640, videoHeight: 480, play: async () => {}});
  if (rvfcMs) video.requestVideoFrameCallback = cb => setTimeout(() => cb(performance.now(), {}), rvfcMs);
  const model = {detect: async () => { api.aoDetectar && api.aoDetectar(performance.now()); calls++; em++; maxEm = Math.max(maxEm, em); try { await sleep(detectMs); if (detectFalha) throw new Error('detect falhou'); return script[i++ % script.length]; } finally { em--; } }};
  new Function('document', 'window', 'navigator', 'cocoSsd', 'speechSynthesis', 'SpeechSynthesisUtterance', SC)(
    {getElementById: mk, createElement: tag => tag === 'canvas' ? {width: 0, height: 0, getContext: () => ({drawImage(){}, getImageData: () => quadro && quadro()})} : {}, addEventListener(){}, hidden: false}, Object.assign(win, {speechSynthesis: ss}),
    {mediaDevices: {getUserMedia: async () => stream, enumerateDevices: async () => []}},
    {load: async () => { await sleep(loadMs); if (loadFalha) throw new Error('sem rede'); return model; }}, ss, class { constructor(t){ this.t = t; } });
  return api = {els, falas, ss, win, calls: () => calls, maxEm: () => maxEm, cancels: () => cancels,
    iniciar: () => els.btnIniciar.onclick(), pausar: () => els.btnPausar.onclick(), encerrar: () => els.btnEncerrar.onclick()};
}
const d = (c, b, s = .8) => ({class: c, score: s, bbox: b});

test('app: painel mostra métricas medidas, FPS da câmera (rVFC) e para tudo ao encerrar', async () => {
  const a = await montar({rvfcMs: 33, detectMs: 12}); assert.match(a.els.mModelo.textContent, /não carregado/);
  try {
    await a.iniciar(); await sleep(1800); a.els.btnIniciar.onclick && 0;
    const e = a.els; assert.match(e.mModelo.textContent, /^pronto/); assert.match(e.mCarga.textContent, /s$/);
    assert.match(e.mInf.textContent, /ms · méd .* · p95/); assert.match(e.mCic.textContent, /ms/); assert.match(e.mFps.textContent, /\/s$/);
    assert.match(e.mCam.textContent, /\/s$/); assert.ok(+e.mFr.textContent >= 10); assert.equal(+e.mErr.textContent, 0);
    assert.equal(a.maxEm(), 1);
  } finally { a.encerrar(); }
  await sleep(60); const c = a.calls(); await sleep(300); assert.equal(a.calls(), c, 'inferência continuou após encerrar');
});
test('app: sem rVFC o painel informa que o FPS da câmera não está disponível', async () => {
  const a = await montar({}); try { await a.iniciar(); await sleep(700); assert.match(a.els.mCam.textContent, /indisponível/); } finally { a.encerrar(); }
});
test('app: modelo "carregando" e falha de carga são indicados; nada fica rodando', async () => {
  const a = await montar({loadMs: 250}); const p = a.iniciar(); await sleep(60);
  assert.match(a.els.mModelo.textContent, /carregando/); await p; assert.match(a.els.mModelo.textContent, /^pronto/); a.encerrar();
  const b = await montar({loadFalha: true}); await b.iniciar(); await sleep(150);
  assert.match(b.els.mModelo.textContent, /erro ao carregar/); assert.match(b.els.status.textContent, /Erro/); assert.equal(b.calls(), 0); assert.equal(b.els.btnIniciar.disabled, false);
});
test('app: pausa/retoma 40× e encerra sem cadeia duplicada nem concorrência', async () => {
  const a = await montar({detectMs: 15, vals: {intervalo: 40}, rvfcMs: 16}); const ini = []; a.aoDetectar = t => ini.push(t); try {
    await a.iniciar(); await sleep(400); let c0 = a.calls(); await sleep(800); const antes = a.calls() - c0;
    for (let k = 0; k < 40; k++){ a.pausar(); await sleep(Math.random() * 40); a.pausar(); await sleep(Math.random() * 40); }
    await sleep(400); c0 = a.calls(); const i0 = ini.length; await sleep(800); const depois = a.calls() - c0;
    assert.equal(a.maxEm(), 1); assert.ok(depois <= antes * 1.25 + 1, `antes=${antes} depois=${depois}`);
    const esp = ini.slice(i0).map((t, k, x) => k ? t - x[k-1] : Infinity).slice(1);
    assert.ok(Math.min(...esp) >= 36, 'espaçamento mínimo ' + Math.min(...esp).toFixed(1) + ' ms');
  } finally { a.encerrar(); }
});
test('app: erros repetidos do modelo avisam uma vez, contam e o app segue tentando', async () => {
  const a = await montar({detectFalha: true}); try { await a.iniciar(); await sleep(900);
    assert.equal(a.falas.filter(t => t === 'Atenção: não foi possível avaliar a passagem. Pare e aguarde.').length, 1);
    assert.ok(+a.els.mErr.textContent >= 3); assert.ok(a.calls() > 5); assert.equal(+a.els.mFr.textContent, 0);
  } finally { a.encerrar(); }
});
test('app: alertas preservados (veículos agrupados, oscilação não repete, pessoa à frente não corta a fala em loop)', async () => {
  const rod = async (script, ms = 1500) => { const a = await montar({script, vals: {intervalo: 20}}); try { await a.iniciar(); await sleep(ms); } finally { a.encerrar(); } return a.falas.filter(t => !/^Assistência/.test(t)); };
  assert.deepEqual(await rod([[d('car', [250, 150, 140, 100]), d('truck', [260, 160, 140, 100])]]), ['Dois veículos à frente. Não foi possível confirmar uma passagem.']);
  const cad1 = d('chair', [40, 150, 80, 150]), cad2 = d('chair', [120, 160, 80, 150]);
  assert.deepEqual(await rod([[cad1, cad2], [cad1]]), ['Duas cadeiras à esquerda.']);
  const pess = d('person', [270, 100, 100, 250]);
  assert.equal((await rod([[pess, d('person', [290, 110, 90, 230])], [pess]])).length, 1);
});

// =====================================================================================================================
// ORIENTAÇÃO ESPACIAL. TUDO AQUI É SIMULADO: detecções, "avaliações de passagem" e imagens são SINTÉTICAS, escritas à mão.
// Os testes de decisão e de mensagens validam a LÓGICA. Os testes do avaliador de piso rodam o algoritmo REAL, mas em imagens artificiais
// (cores uniformes): provam que o código faz o que descreve, NÃO que ele acerta em fotos reais de fábrica. Não validam COCO-SSD, câmera nem celular.
// =====================================================================================================================
const W = 640, H = 480;
const og = (cls, cx, w = .15, h = .4, n = 1, inv = false) => { const b = [cx*W - w*W/2, 100, w*W, h*H]; return {cls, info: P.CLASSES[cls], z: P.zonaDe(b, W, inv), n, area: b[2]*b[3]/(W*H)}; };
const E_ = () => og('chair', .15), F_ = () => og('chair', .5), D_ = () => og('chair', .85);           // cadeira na esquerda / frente / direita
const BOA = (extra = {}) => Object.assign({livre: .9, continuidade: .9, larguraRel: .8, confianca: .8}, extra);   // região com evidência positiva
const RUIM = {livre: .2, continuidade: .2, larguraRel: .1, confianca: .8};
// avaliação de passagem SIMULADA: por padrão as três regiões têm boa evidência (as obstruídas por objeto serão descartadas pela decisão)
const segSim = (reg = {}, extra = {}) => Object.assign({estado: 'ok', cobertura: .95, idadeMs: 100, regioes: Object.assign({esquerda: BOA(), frente: BOA(), direita: BOA()}, reg)}, extra);
const dec = (grupos, extra = {}) => P.decidirOrientacao(Object.assign({grupos, deteccao: {estado: 'ok'}}, extra));
const fala = (grupos, extra = {}) => { const d = dec(grupos, extra); return {d, p: grupos.length ? P.planejar(grupos, d) : P.planejarSemObjetos(d)}; };

test('[simulado] Regra 1: centro e direita obstruídos, passagem à esquerda validada', () => {
  const {d, p} = fala([F_(), D_()], {seg: segSim()});
  assert.equal(d.decisao, 'possivel_passagem_esquerda'); assert.deepEqual(d.bloqueadas.sort(), ['direita', 'frente']); assert.deepEqual(d.passagens, ['esquerda']);
  assert.equal(d.evidencias.zonas.esquerda.valida, true); assert.equal(p.texto, 'Obstáculo à frente e à direita. Possível passagem à esquerda.');
});
test('[simulado] Regra 2: centro e esquerda obstruídos, passagem à direita validada', () => {
  const {d, p} = fala([F_(), E_()], {seg: segSim()});
  assert.equal(d.decisao, 'possivel_passagem_direita'); assert.equal(p.texto, 'Obstáculo à frente e à esquerda. Possível passagem à direita.');
});
test('[simulado] Regra 3: laterais obstruídas, passagem central validada (e sem validação, não indica o centro)', () => {
  let {d, p} = fala([E_(), D_()], {seg: segSim()});
  assert.equal(d.decisao, 'possivel_passagem_centro'); assert.deepEqual(d.passagens, ['frente']); assert.equal(p.texto, 'Obstáculos nas laterais. Possível passagem pelo centro.');
  ({d, p} = fala([E_(), D_()], {seg: segSim({frente: BOA({continuidade: .3})})}));
  assert.equal(d.decisao, 'passagem_nao_confirmada'); assert.deepEqual(d.passagens, []); assert.equal(p.texto, 'Cadeira à esquerda e cadeira à direita. Não foi possível confirmar uma passagem.');
  assert.match(p.texto, /Não foi possível confirmar uma passagem\.$/); assert.doesNotMatch(p.texto, /pelo centro/);
  ({d, p} = fala([E_(), D_()]));                                                    // sem nenhuma avaliação de passagem
  assert.equal(d.decisao, 'passagem_nao_confirmada'); assert.deepEqual(d.passagens, []);
});
test('[simulado] Regra 4: centro obstruído e as duas laterais validadas: informa as duas; só escolhe uma por critério objetivo', () => {
  let {d, p} = fala([F_()], {seg: segSim()});                                       // pontuações iguais
  assert.equal(d.decisao, 'possiveis_passagens_esquerda_e_direita'); assert.deepEqual(d.passagens, ['esquerda', 'direita']);
  assert.equal(p.texto, 'Obstáculo à frente. Passagens possíveis à esquerda e à direita.');
  ({d, p} = fala([F_()], {seg: segSim({esquerda: BOA({larguraRel: 1, continuidade: 1, confianca: .9}), direita: BOA({larguraRel: .55, continuidade: .7, confianca: .65})})}));
  assert.equal(d.decisao, 'possivel_passagem_esquerda'); assert.deepEqual(d.passagens, ['esquerda']); assert.match(d.evidencias.criterio, /largura×continuidade×confiança/);
  assert.equal(p.texto, 'Obstáculo à frente. Possível passagem à esquerda.');
  ({d} = fala([F_()], {seg: segSim({esquerda: BOA({larguraRel: .55, continuidade: .7, confianca: .65}), direita: BOA({larguraRel: 1, continuidade: 1, confianca: .9})})}));
  assert.equal(d.decisao, 'possivel_passagem_direita');                               // espelho: o critério não favorece um lado fixo
});
test('[simulado] Regra 5: todas as regiões obstruídas → não indica direção, manda parar (urgente)', () => {
  const {d, p} = fala([E_(), F_(), D_()], {seg: segSim()});
  assert.equal(d.decisao, 'obstaculos_todas_direcoes'); assert.deepEqual(d.passagens, []); assert.equal(p.texto, 'Obstáculos em todas as direções analisadas. Pare e solicite auxílio.');
  assert.equal(p.urgente, true);
});
test('[simulado] Regra 6: só o centro obstruído; uma lateral validada, nenhuma validada, ou lateral só "sem objeto"', () => {
  let {d, p} = fala([F_()], {seg: segSim({direita: RUIM})});
  assert.equal(d.decisao, 'possivel_passagem_esquerda'); assert.equal(p.texto, 'Obstáculo à frente. Possível passagem à esquerda.');
  ({d, p} = fala([F_()], {seg: segSim({esquerda: RUIM, direita: RUIM})}));
  assert.equal(d.decisao, 'passagem_nao_confirmada'); assert.equal(p.texto, 'Cadeira à frente. Não foi possível confirmar uma passagem.');
  ({d, p} = fala([og('person', .5)]));                                              // sem avaliação: sem caixas nas laterais NÃO é passagem
  assert.equal(d.decisao, 'passagem_nao_confirmada'); assert.equal(p.texto, 'Pessoa à frente. Não foi possível confirmar uma passagem.');
});
test('[simulado] Regra 7: obstáculo só à esquerda / só à direita; o lado oposto só é indicado com passagem validada', () => {
  let {d, p} = fala([E_()], {seg: segSim()});
  assert.equal(d.decisao, 'possivel_passagem_direita'); assert.equal(p.texto, 'Obstáculo à esquerda. Possível passagem à direita.');
  ({d, p} = fala([D_()], {seg: segSim()}));
  assert.equal(d.decisao, 'possivel_passagem_esquerda'); assert.equal(p.texto, 'Obstáculo à direita. Possível passagem à esquerda.');
  for (const [seg, re] of [[undefined, /sem avaliação de passagem/], [segSim({esquerda: RUIM}), /pouca área livre/], [segSim({esquerda: BOA({larguraRel: .2})}), /largura/], [segSim({esquerda: BOA({continuidade: .2})}), /continuidade/],
                           [segSim({esquerda: BOA({confianca: .3})}), /baixa confiança/], [segSim({}, {regioes: {direita: BOA()}}), /sem dados da região/]]){
    ({d, p} = fala([D_()], {seg}));
    assert.equal(d.decisao, 'obstaculo_direita', String(re)); assert.deepEqual(d.passagens, []); assert.equal(p.texto, 'Cadeira à direita.'); assert.match(d.motivos.join(' '), re);
  }
  ({d} = fala([D_()], {seg: segSim(), prof: {estado: 'ok', regioes: {esquerda: {proximidade: .9}}}}));   // profundidade relativa só pode VETAR
  assert.equal(d.decisao, 'obstaculo_direita'); assert.match(d.evidencias.zonas.esquerda.motivo, /profundidade relativa/);
  ({d} = fala([D_()], {seg: segSim(), candidatos: [{z: 'esquerda', area: .1, nome: 'cadeira'}]}));          // possível objeto de baixa confiança no lado
  assert.equal(d.decisao, 'obstaculo_direita');
});
test('[simulado] Ausência de objetos, sem passagem validada: nunca "caminho livre"', () => {
  let {d, p} = fala([]);
  assert.equal(d.decisao, 'nenhum_objeto_reconhecido'); assert.deepEqual(d.passagens, []); assert.equal(p.texto, 'Nenhum obstáculo reconhecido. Não foi possível confirmar uma passagem.');
  ({d, p} = fala([], {seg: segSim({frente: RUIM})})); assert.equal(p.texto, 'Nenhum obstáculo reconhecido. Não foi possível confirmar uma passagem.');   // laterais boas não bastam sem objeto
  ({d, p} = fala([], {seg: segSim()}));                                                                      // com evidência no centro: só "possível"
  assert.equal(p.texto, 'Nenhum obstáculo reconhecido. Possível passagem pelo centro.'); assert.doesNotMatch(p.texto, /caminho livre|seguro/);
});
test('[simulado] Regra 8: falha do modelo, baixa confiança e dados desatualizados não inventam direção', () => {
  for (const deteccao of [{estado: 'falha', motivo: 'x'}, {estado: 'incompleto'}, {estado: 'ok', idadeMs: 5000}]){
    const {d, p} = fala([D_()], {seg: segSim(), deteccao});
    assert.equal(d.decisao, 'analise_insuficiente'); assert.deepEqual(d.passagens, []); assert.equal(p.texto, 'Não foi possível avaliar a passagem adequadamente.');
    assert.doesNotMatch(p.texto, /esquerda|direita|frente|centro/);
  }
  let r = fala([], {candidatos: [{z: 'frente', area: .2, nome: 'pessoa'}], seg: segSim()});                  // só baixa confiança
  assert.equal(r.d.decisao, 'analise_insuficiente'); assert.ok(r.d.limitacoes.includes('baixa_confianca')); assert.equal(r.p.texto, 'Não foi possível avaliar a passagem adequadamente.');
  for (const seg of [segSim({}, {idadeMs: 5000}), segSim({}, {estado: 'falha'}), segSim({}, {estado: 'incompleto', motivo: 'referência coberta'}), segSim({}, {cobertura: .2})]){   // passagem sem dados utilizáveis
    r = fala([F_()], {seg});
    assert.equal(r.d.decisao, 'passagem_nao_confirmada'); assert.deepEqual(r.d.passagens, []); assert.ok(r.d.limitacoes.includes('passagem_nao_avaliada'));
    assert.equal(r.p.texto, 'Cadeira à frente. Não foi possível avaliar a passagem adequadamente.');
  }
  r = fala([D_()], {seg: segSim({}, {idadeMs: 5000})}); assert.equal(r.p.texto, 'Cadeira à direita.');           // obstáculo continua sendo informado
});
test('[simulado] estabilização: passagem que pisca não liga; falha isolada não derruba; objeto na região derruba na hora', () => {
  const e = P.criarEstabilizadorAlt(), ciclo = (b, im = []) => e.filtrar(b, im);
  for (let i = 0; i < 20; i++) assert.deepEqual(ciclo(i % 2 ? ['esquerda'] : []), []);
  ciclo(['esquerda']); ciclo(['esquerda']); assert.deepEqual(ciclo(['esquerda']), ['esquerda']);
  assert.deepEqual(ciclo([]), ['esquerda']); assert.deepEqual(ciclo(['esquerda']), ['esquerda']);
  ciclo([]); ciclo([]); assert.deepEqual(ciclo([]), []);
  ciclo(['frente']); ciclo(['frente']); assert.deepEqual(ciclo(['frente']), ['frente']);                       // vale também para o centro
  assert.deepEqual(ciclo(['frente'], ['frente']), []);
  const estab = P.criarEstabilizadorAlt(), d = () => dec([D_()], {seg: segSim(), estab}).decisao;
  assert.deepEqual([d(), d(), d()], ['obstaculo_direita', 'obstaculo_direita', 'possivel_passagem_esquerda']);
});
test('[simulado] a expressão "ocupando boa parte da imagem" não existe em lugar nenhum (código, HTML, mensagens, registros)', () => {
  assert.ok(!/ocupando boa parte/i.test(fs.readFileSync(HTML, 'utf8')), 'ainda existe no arquivo HTML');
  const grande = [{cls: 'dining table', info: P.CLASSES['dining table'], z: 'frente', n: 1, area: .8}, {cls: 'person', info: P.CLASSES.person, z: 'esquerda', n: 1, area: .6}];
  for (const seg of [undefined, segSim()]) for (const gs of [grande, [grande[0]], [grande[1]]]){ const p = P.planejar(gs, dec(gs, {seg})); assert.ok(!/ocupando|boa parte|imagem/i.test(p.texto + p.curto), p.texto); }
});

// ---------- avaliador de passagem (algoritmo REAL, imagens ARTIFICIAIS) ----------
const imagem = (fn, w = 64, h = 48) => { const data = new Uint8ClampedArray(w*h*4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++){ const c = fn(x, y), i = 4*(y*w + x); data[i] = c[0]; data[i+1] = c[1]; data[i+2] = c[2]; data[i+3] = 255; } return {data, w, h}; };
const CHAO = [120, 118, 115], OUTRO = [40, 70, 160];
test('[simulado] avaliador de piso: piso uniforme dá as três regiões livres, contínuas e largas; a decisão correspondente sai', () => {
  const r = P.avaliarPassagemPorCor(imagem(() => CHAO), []);
  assert.equal(r.estado, 'ok'); assert.equal(r.metodo, 'heuristica_cor_piso');
  for (const z of ['esquerda', 'frente', 'direita']){ assert.ok(r.regioes[z].livre > .95 && r.regioes[z].continuidade === 1 && r.regioes[z].larguraRel === 1, z); assert.ok(r.regioes[z].confianca <= .9); }
  assert.equal(dec([F_()], {seg: Object.assign({idadeMs: 0}, r)}).decisao, 'possiveis_passagens_esquerda_e_direita');
});
test('[simulado] avaliador de piso: caixa de objeto e mudança de cor invalidam só a região afetada; a caixa é aplicada na orientação BRUTA e os lados seguem a inversão', () => {
  const cx = {x: .35, y: .3, w: .3, h: .5};                                           // caixa no centro da imagem (acima da faixa de referência do piso)
  let r = P.avaliarPassagemPorCor(imagem(() => CHAO), [cx]);
  assert.ok(r.regioes.frente.livre < .5 && r.regioes.frente.continuidade < .5); assert.ok(r.regioes.esquerda.livre > .95 && r.regioes.direita.livre > .95);
  const dir = {x: .7, y: .3, w: .3, h: .65};                                           // caixa na DIREITA da imagem
  r = P.avaliarPassagemPorCor(imagem(() => CHAO), [dir], false); assert.ok(r.regioes.direita.livre < .5 && r.regioes.esquerda.livre > .95);
  r = P.avaliarPassagemPorCor(imagem(() => CHAO), [dir], true);  assert.ok(r.regioes.esquerda.livre < .5 && r.regioes.direita.livre > .95);   // câmera invertida: lado do USUÁRIO é o oposto
  r = P.avaliarPassagemPorCor(imagem((x, y) => x >= 43 && y >= 24 ? OUTRO : CHAO), []);  // terço direito, metade inferior, outra cor (ex.: parede ou piso diferente)
  assert.ok(r.regioes.direita.livre < .2 && r.regioes.esquerda.livre > .95);
  r = P.avaliarPassagemPorCor(imagem((x, y) => x >= 43 && y >= 38 && y < 42 ? OUTRO : CHAO), []);   // faixa horizontal perto da base, cortando o caminho: quebra a continuidade
  assert.ok(r.regioes.direita.livre > .8 && r.regioes.direita.continuidade < .2);
  r = P.avaliarPassagemPorCor(imagem((x, y) => x >= 43 && x < 58 && y >= 24 ? OUTRO : CHAO), []);   // só ~30% da largura da região continua livre
  assert.ok(r.regioes.direita.larguraRel < .5);
  assert.equal(dec([E_(), F_()], {seg: Object.assign({idadeMs: 0}, r)}).decisao, 'passagem_nao_confirmada');   // largura insuficiente: não valida a direita
});
test('[simulado] avaliador de piso: sem referência confiável não valida nada (incompleto), e a decisão diz que não avaliou', () => {
  const casos = [[imagem(() => [5, 5, 5]), /escura/], [imagem(() => [250, 250, 250]), /clara/],
                 [imagem((x, y) => (x * 7 + y * 13) % 2 ? [20, 200, 20] : [220, 30, 120]), /homogênea/]];
  for (const [img, re] of casos){ const r = P.avaliarPassagemPorCor(img, []); assert.equal(r.estado, 'incompleto'); assert.match(r.motivo, re); }
  let r = P.avaliarPassagemPorCor(imagem(() => CHAO), [{x: .3, y: .7, w: .4, h: .3}]); assert.equal(r.estado, 'incompleto'); assert.match(r.motivo, /coberta/);   // objeto sobre a referência
  assert.equal(P.avaliarPassagemPorCor({data: new Uint8ClampedArray(4), w: 64, h: 48}, []).estado, 'falha');
  const d = dec([F_()], {seg: Object.assign({idadeMs: 0}, r)});
  assert.equal(d.decisao, 'passagem_nao_confirmada'); assert.deepEqual(d.passagens, []); assert.equal(P.planejar([F_()], d).texto, 'Cadeira à frente. Não foi possível avaliar a passagem adequadamente.');
});

// ---------- app completo (simulado) ----------
const naoInicio = fal => fal.filter(t => !/^Assistência/.test(t));
const cadE = d('chair', [40, 150, 80, 150]);          // caixa à ESQUERDA da imagem (x 40..120 de 640)
const cadC = d('chair', [270, 150, 100, 150]), cadD = d('chair', [540, 150, 80, 150]);
test('[simulado] app: avaliação de piso ligada, pipeline completo: objeto detectado + imagem artificial → mensagem da Regra 6/4 e barras coerentes', async () => {
  const a = await montar({script: [[cadC]], vals: {intervalo: 20, passagem: 'ligada'}, quadro: () => imagem(() => CHAO)});
  try { await a.iniciar(); await sleep(1500); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Obstáculo à frente. Passagens possíveis à esquerda e à direita.']);   // só depois do aquecimento: nada de "sem passagem" cedo demais
  assert.equal(a.els.oDec.textContent, 'possiveis_passagens_esquerda_e_direita'); assert.match(a.els.oSeg.textContent, /E 10\d?%|E 100%/);
  const b = await montar({script: [[cadC]], vals: {intervalo: 20, passagem: 'ligada'}, quadro: () => null});    // captura falha: não inventa passagem
  try { await b.iniciar(); await sleep(1000); } finally { b.encerrar(); }
  assert.deepEqual(naoInicio(b.falas), ['Cadeira à frente. Não foi possível avaliar a passagem adequadamente.']);
});
test('[simulado] app: passagem externa oscilando a cada ciclo não muda a fala; estável gera UMA mensagem com a passagem', async () => {
  let a = await montar({script: [[cadD]], vals: {intervalo: 20}}); let k = 0;
  a.aoDetectar = () => { k++; a.win.VisioIndustria.receberSegmentacao(k % 2 ? segSim() : segSim({esquerda: RUIM})); };
  try { await a.iniciar(); await sleep(1500); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Cadeira à direita.']);
  a = await montar({script: [[cadD]], vals: {intervalo: 20}}); a.aoDetectar = () => a.win.VisioIndustria.receberSegmentacao(segSim());   // reenvia a cada ciclo, como um modelo que atualiza
  try { await a.iniciar(); await sleep(2000); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Obstáculo à direita. Possível passagem à esquerda.']);
});
test('[simulado] app: nunca interrompe fala em andamento; repetição por tempo usa só o obstáculo; aviso de "sem objeto" sai uma vez', async () => {
  let a = await montar({script: [[cadC]], vals: {intervalo: 20}}); a.aoDetectar = () => a.win.VisioIndustria.receberSegmentacao(segSim());
  try { await a.iniciar(); a.ss.speaking = true; const c0 = a.cancels(); await sleep(1200); assert.equal(a.cancels(), c0, 'cancelou fala em andamento'); assert.deepEqual(naoInicio(a.falas), []); } finally { a.encerrar(); }
  a = await montar({script: [[cadC]], vals: {intervalo: 20, cool: 1}});                                       // cadeira à frente, repetição a cada 2 s
  try { await a.iniciar(); await sleep(2700); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas).slice(0, 2), ['Cadeira à frente. Não foi possível confirmar uma passagem.', 'Cadeira à frente.']);
  const script = [...Array(10).fill([cadE]), ...Array(500).fill([])];
  a = await montar({script, vals: {intervalo: 20}});
  try { await a.iniciar(); await sleep(1500); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Cadeira à esquerda.', 'Nenhum obstáculo reconhecido. Não foi possível confirmar uma passagem.']);
});
test('[simulado] app: resultado nulo do modelo → "não foi possível avaliar" uma vez, sem direção, sem estourar erro de ciclo', async () => {
  const a = await montar({script: [null], vals: {intervalo: 20}});
  try { await a.iniciar(); await sleep(900); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Não foi possível avaliar a passagem adequadamente.']); assert.equal(+a.els.mErr.textContent, 0); assert.equal(a.els.oDec.textContent, 'analise_insuficiente');
});
test('[simulado] app: o lado anunciado, as barras e os rótulos seguem o lado do USUÁRIO (câmera normal, invertida, frontal)', async () => {
  const bE = [40, 100, 80, 150], bD = [520, 100, 80, 150], bC = [280, 100, 80, 150];
  assert.equal(P.zonaDe(bE, 640), 'esquerda'); assert.equal(P.zonaDe(bD, 640), 'direita'); assert.equal(P.zonaDe(bC, 640), 'frente');
  assert.equal(P.zonaDe(bE, 640, true), 'direita'); assert.equal(P.zonaDe(bD, 640, true), 'esquerda'); assert.equal(P.zonaDe(bC, 640, true), 'frente');
  assert.deepEqual(P.resolverLados('auto', 'environment'), {invertido: false, motivo: 'câmera traseira'});
  assert.equal(P.resolverLados('auto', 'user').invertido, true); assert.equal(P.resolverLados('auto', '').invertido, false);
  assert.equal(P.resolverLados('normal', 'user').invertido, false); assert.equal(P.resolverLados('invertido', 'environment').invertido, true);
  assert.deepEqual(P.rotulosLados(false), ['esquerda', 'direita']); assert.deepEqual(P.rotulosLados(true), ['direita', 'esquerda']);
  // a regra completa respeita a inversão: obstáculo no canto ESQUERDO da imagem com câmera invertida é obstáculo à DIREITA; a passagem fica à ESQUERDA do usuário
  const gs = [og('chair', .1, .15, .4, 1, true)]; assert.equal(P.planejar(gs, dec(gs, {seg: segSim()})).texto, 'Obstáculo à direita. Possível passagem à esquerda.');
  const rodar = async (vals, facing) => { const a = await montar({script: [[cadE]], vals: Object.assign({intervalo: 20}, vals), facing}); try { await a.iniciar(); await sleep(700); } finally { a.encerrar(); } return {f: naoInicio(a.falas), a}; };
  let x = await rodar({lados: 'normal'}, 'environment'); assert.deepEqual(x.f, ['Cadeira à esquerda.']); assert.equal(x.a.els.rotE.textContent, 'esquerda'); assert.equal(x.a.els.rotD.textContent, 'direita');
  x = await rodar({lados: 'invertido'}, 'environment'); assert.deepEqual(x.f, ['Cadeira à direita.']); assert.equal(x.a.els.rotE.textContent, 'direita'); assert.match(x.a.els.oLados.textContent, /invertidos/);
  x = await rodar({lados: 'auto'}, 'user'); assert.deepEqual(x.f, ['Cadeira à direita.']);
  x = await rodar({lados: 'auto'}, 'environment'); assert.deepEqual(x.f, ['Cadeira à esquerda.']);
  x = await rodar({lados: 'auto'}, ''); assert.deepEqual(x.f, ['Cadeira à esquerda.']);
  // pipeline de pixels + inversão no app: caixa na esquerda da imagem e câmera invertida → obstáculo à direita; piso livre à esquerda do usuário
  const y = await montar({script: [[cadE]], vals: {intervalo: 20, lados: 'invertido', passagem: 'ligada'}, quadro: () => imagem(() => CHAO)});
  try { await y.iniciar(); await sleep(1500); } finally { y.encerrar(); }
  assert.deepEqual(naoInicio(y.falas), ['Obstáculo à direita. Possível passagem à esquerda.']);
});

// =====================================================================================================================
// MODO PISTA CONTROLADA (EXPERIMENTAL). TUDO AQUI É SIMULADO: detecções sintéticas escritas à mão.
// Validam a LÓGICA de decisão, as mensagens e a estabilidade. NÃO validam COCO-SSD, câmera, celular nem a pista física.
// Neste modo "região disponível" é uma PREMISSA da pista (sem obstáculo confirmado e sem possível objeto), não uma prova da câmera.
// =====================================================================================================================
const decP = (grupos, extra = {}) => P.decidirOrientacao(Object.assign({grupos, modo: 'pista', deteccao: {estado: 'ok'}}, extra));
const falaP = (grupos, extra = {}) => { const d = decP(grupos, extra); return {d, p: grupos.length ? P.planejar(grupos, d) : P.planejarSemObjetos(d)}; };
const PERMITIDAS = new Set(['Obstáculo à frente. Desvie pela esquerda.', 'Obstáculo à frente. Desvie pela direita.', 'Obstáculo à esquerda. Siga pela direita.', 'Obstáculo à direita. Siga pela esquerda.',
  'Obstáculo à frente e à esquerda. Desvie pela direita.', 'Obstáculo à frente e à direita. Desvie pela esquerda.', 'Laterais obstruídas. Siga pelo centro.',
  'Pare. Obstáculos identificados em todas as direções.', 'Não foi possível avaliar a passagem. Pare e aguarde.', 'Nenhum obstáculo reconhecido. Isso não indica caminho livre.']);

test('[simulado][pista] 1/10. obstáculo só no centro, duas passagens: escolha consistente (prioridade fixa) e mensagem de desvio', () => {
  const {d, p} = falaP([F_()]);
  assert.equal(d.decisao, 'desvio_esquerda'); assert.deepEqual(d.bloqueadas, ['frente']); assert.deepEqual(d.passagens, ['esquerda']); assert.deepEqual(d.evidencias.opcoes, ['esquerda', 'direita']);
  assert.equal(p.texto, 'Obstáculo à frente. Desvie pela esquerda.'); assert.match(d.motivos.join(' '), /prioridade fixa/);
  for (let i = 0; i < 50; i++) assert.equal(decP([F_()]).decisao, 'desvio_esquerda');                          // determinístico: nunca aleatório
  const s = decP([F_()], {ultimaEscolha: 'direita'});                                                         // escolha anterior vale enquanto a região continuar disponível
  assert.equal(s.decisao, 'desvio_direita'); assert.equal(P.planejar([F_()], s).texto, 'Obstáculo à frente. Desvie pela direita.'); assert.match(s.motivos.join(' '), /escolha anterior/);
  const so = decP([F_()], {candidatos: [{z: 'esquerda', area: .1, nome: 'cadeira'}], ultimaEscolha: 'esquerda'});   // anterior deixou de valer: troca de verdade, uma vez
  assert.equal(so.decisao, 'desvio_direita');
  assert.ok(decP([F_()]).limitacoes.includes('disponibilidade_assumida_pela_pista_nao_comprovada_pela_camera'));
});
test('[simulado][pista] 2. obstáculo à esquerda → siga pela direita', () => {
  const {d, p} = falaP([E_()]);
  assert.equal(d.decisao, 'seguir_direita'); assert.deepEqual(d.bloqueadas, ['esquerda']); assert.equal(p.texto, 'Obstáculo à esquerda. Siga pela direita.');
});
test('[simulado][pista] 3. obstáculo à direita → siga pela esquerda', () => {
  const {d, p} = falaP([D_()]);
  assert.equal(d.decisao, 'seguir_esquerda'); assert.equal(p.texto, 'Obstáculo à direita. Siga pela esquerda.');
});
test('[simulado][pista] 4. centro e esquerda obstruídos → desvie pela direita', () => {
  const {d, p} = falaP([F_(), E_()]);
  assert.equal(d.decisao, 'desvio_direita'); assert.deepEqual(d.bloqueadas.sort(), ['esquerda', 'frente']); assert.equal(p.texto, 'Obstáculo à frente e à esquerda. Desvie pela direita.');
});
test('[simulado][pista] 5. centro e direita obstruídos → desvie pela esquerda', () => {
  const {d, p} = falaP([F_(), D_()]);
  assert.equal(d.decisao, 'desvio_esquerda'); assert.equal(p.texto, 'Obstáculo à frente e à direita. Desvie pela esquerda.');
});
test('[simulado][pista] 6. laterais obstruídas, centro disponível → siga pelo centro', () => {
  const {d, p} = falaP([E_(), D_()]);
  assert.equal(d.decisao, 'seguir_centro'); assert.deepEqual(d.passagens, ['frente']); assert.equal(p.texto, 'Laterais obstruídas. Siga pelo centro.');
});
test('[simulado][pista] 7. obstáculos nas três regiões → pare, sem direção, alerta urgente', () => {
  const {d, p} = falaP([E_(), F_(), D_()]);
  assert.equal(d.decisao, 'obstaculos_todas_direcoes'); assert.deepEqual(d.passagens, []); assert.equal(d.escolha, undefined);
  assert.equal(p.texto, 'Pare. Obstáculos identificados em todas as direções.'); assert.equal(p.urgente, true); assert.doesNotMatch(p.texto, /desvie|siga/i);
});
test('[simulado][pista] 8. nenhum obstáculo: não diz caminho livre; baixa confiança isolada não vira direção', () => {
  const {d, p} = falaP([]);
  assert.equal(d.decisao, 'nenhum_obstaculo_reconhecido'); assert.deepEqual(d.passagens, []); assert.deepEqual(d.bloqueadas, []);
  assert.equal(p.texto, 'Nenhum obstáculo reconhecido. Isso não indica caminho livre.'); assert.doesNotMatch(p.texto, /segur|desvie|siga/i);
  assert.ok(d.limitacoes.includes('ausencia_de_deteccao_nao_indica_caminho_livre'));
});
test('[simulado][pista] 9. resultado inválido, inconclusivo, baixa confiança ou dados velhos → "Pare e aguarde", sem direção', () => {
  for (const deteccao of [{estado: 'falha', motivo: 'x'}, {estado: 'incompleto'}, {estado: 'ok', idadeMs: 5000}]){
    const {d, p} = falaP([F_()], {deteccao});
    assert.equal(d.decisao, 'analise_insuficiente'); assert.deepEqual(d.passagens, []); assert.equal(p.texto, 'Não foi possível avaliar a passagem. Pare e aguarde.'); assert.doesNotMatch(p.texto, /esquerda|direita|centro|frente/);
  }
  let r = falaP([], {candidatos: [{z: 'frente', area: .2, nome: 'pessoa'}]});
  assert.equal(r.d.decisao, 'analise_insuficiente'); assert.equal(r.p.texto, 'Não foi possível avaliar a passagem. Pare e aguarde.');
  r = falaP([F_()], {candidatos: [{z: 'esquerda', area: .1, nome: 'x'}, {z: 'direita', area: .1, nome: 'x'}]});          // única saída possível está sob suspeita: não inventa
  assert.equal(r.d.decisao, 'analise_insuficiente'); assert.equal(r.p.texto, 'Não foi possível avaliar a passagem. Pare e aguarde.');
  r = falaP([E_(), D_()], {candidatos: [{z: 'frente', area: .1, nome: 'x'}]}); assert.equal(r.d.decisao, 'analise_insuficiente');
});
test('[simulado][pista] independe da heurística de cor: dado de passagem ruim, velho ou ausente não bloqueia nem muda a orientação', () => {
  const ruim = {estado: 'ok', cobertura: .9, idadeMs: 0, regioes: {esquerda: {livre: .1, continuidade: 0, larguraRel: 0, confianca: .9}, frente: {livre: .1, continuidade: 0, larguraRel: 0, confianca: .9}, direita: {livre: .1, continuidade: 0, larguraRel: 0, confianca: .9}}};
  for (const seg of [undefined, ruim, {estado: 'falha'}, {estado: 'ok', cobertura: .9, idadeMs: 99999, regioes: {}}]) assert.equal(falaP([F_()], {seg}).p.texto, 'Obstáculo à frente. Desvie pela esquerda.');
  assert.equal(P.planejar([F_()], dec([F_()], {seg: ruim})).texto, 'Cadeira à frente. Não foi possível confirmar uma passagem.');   // modo padrão segue conservador
});
test('[simulado][pista] toda combinação de regiões produz só mensagens previstas, sem expressão proibida nem "livre/seguro" afirmativo', () => {
  const Z = [E_, F_, D_], vistos = new Set();
  for (let m = 0; m < 8; m++) for (const cand of [false, true]){
    const gs = Z.filter((_, i) => m & (1 << i)).map(f => f());
    const {d, p} = falaP(gs, {candidatos: cand ? [{z: 'frente', area: .2, nome: 'x'}] : []});
    vistos.add(p.texto); assert.ok(PERMITIDAS.has(p.texto), `${m}/${cand}: ${p.texto}`);
    assert.doesNotMatch(p.texto, /ocupando|boa parte|imagem|segur/i);
    if (d.passagens.length) assert.ok(!d.bloqueadas.includes(d.passagens[0]), 'indicou região obstruída');
  }
  assert.ok(vistos.size >= 8);
});
test('[simulado][pista] 14a. alerta urgente: pessoa ou veículo à frente é marcado urgente; cadeira não; novo item urgente muda a assinatura', () => {
  const pessoa = og('person', .5), carro = og('car', .5);
  assert.equal(P.planejar([pessoa], decP([pessoa])).urgente, true); assert.equal(P.planejar([carro], decP([carro])).urgente, true);
  assert.equal(P.planejar([F_()], decP([F_()])).urgente, false); assert.equal(P.planejar([og('person', .15)], decP([og('person', .15)])).urgente, false);
  assert.notEqual(P.planejar([pessoa], decP([pessoa])).ass, P.planejar([F_()], decP([F_()])).ass);
  assert.equal(P.planejar([F_(), og('chair', .5, .15, .4, 3)], decP([og('chair', .5, .15, .4, 3)])).ass, P.planejar([F_()], decP([F_()])).ass);   // contagem não muda a assinatura
});

// ---------- app completo, modo pista (simulado) ----------
const pista = (script, vals = {}, extra = {}) => montar(Object.assign({script, vals: Object.assign({intervalo: 20, modo: 'pista'}, vals)}, extra));
const cadCenter2 = d('chair', [200, 160, 90, 140]);                                                       // segunda cadeira, também na região central
test('[simulado][pista] app: cada configuração planejada fala a instrução certa, uma vez, sem usar a heurística de cor', async () => {
  const casos = [[[cadC], 'Obstáculo à frente. Desvie pela esquerda.'], [[cadE], 'Obstáculo à esquerda. Siga pela direita.'], [[cadD], 'Obstáculo à direita. Siga pela esquerda.'],
                 [[cadC, cadE], 'Obstáculo à frente e à esquerda. Desvie pela direita.'], [[cadC, cadD], 'Obstáculo à frente e à direita. Desvie pela esquerda.'],
                 [[cadE, cadD], 'Laterais obstruídas. Siga pelo centro.'], [[cadE, cadC, cadD], 'Pare. Obstáculos identificados em todas as direções.']];
  for (const [dets, msg] of casos){
    let chamadas = 0; const a = await pista([dets], {passagem: 'ligada'}, {quadro: () => { chamadas++; return imagem(() => CHAO); }});
    try { await a.iniciar(); await sleep(800); } finally { a.encerrar(); }
    assert.deepEqual(naoInicio(a.falas), [msg], msg); assert.equal(chamadas, 0, 'o modo pista não deve usar a heurística de piso');
    assert.match(a.els.oDec.textContent, /pista experimental/); assert.equal(a.els.oSeg.textContent, 'não usada no modo pista');
  }
});
test('[simulado][pista] app 11. oscilação temporária da detecção não troca nem repete a orientação', async () => {
  const ciclo = [[cadC], [cadC], [], [cadC], [cadC], [cadC], [], [cadC], [cadC], [cadC], [], [cadC]];       // falhas isoladas de 1 ciclo, dentro da tolerância
  const a = await pista([...ciclo, ...ciclo, ...ciclo, ...ciclo]);
  try { await a.iniciar(); await sleep(1300); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Obstáculo à frente. Desvie pela esquerda.']);
});
test('[simulado][pista] app 12. mesma orientação não é repetida a cada análise; mudar a contagem de objetos na região não gera nova fala; repete só após o intervalo', async () => {
  let a = await pista([...Array(15).fill([cadC]), ...Array(500).fill([cadC, cadCenter2])]);
  try { await a.iniciar(); await sleep(1500); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Obstáculo à frente. Desvie pela esquerda.']); assert.ok(+a.els.mSup.textContent > 10, 'suprimidas: ' + a.els.mSup.textContent);
  a = await pista([[cadC]], {cool: 1});
  try { await a.iniciar(); await sleep(2700); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas).slice(0, 2), ['Obstáculo à frente. Desvie pela esquerda.', 'Obstáculo à frente. Desvie pela esquerda.']);      // reafirma depois do cooldown
  assert.ok(naoInicio(a.falas).length <= 2);
});
test('[simulado][pista] app 13. obstáculo que muda de região: a orientação muda uma vez, depois de confirmada', async () => {
  const a = await pista([...Array(12).fill([cadC]), ...Array(500).fill([cadE])]);
  try { await a.iniciar(); await sleep(2400); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Obstáculo à frente. Desvie pela esquerda.', 'Obstáculo à esquerda. Siga pela direita.']);
});
test('[simulado][pista] app 14b. alerta urgente interrompe fala em andamento; baixa prioridade nunca interrompe', async () => {
  const pessoaC = d('person', [270, 100, 110, 300]);
  const a = await pista([...Array(12).fill([cadE]), ...Array(500).fill([cadE, pessoaC])]); let c0 = 0;
  try {
    await a.iniciar(); a.ss.speaking = true; c0 = a.cancels();
    await sleep(250); assert.equal(a.cancels(), c0, 'baixa prioridade cancelou fala'); assert.deepEqual(naoInicio(a.falas), []);
    await sleep(900);
  } finally { a.encerrar(); }
  assert.ok(a.cancels() > c0, 'o alerta urgente deveria ter cancelado a fala em curso'); assert.deepEqual(naoInicio(a.falas), ['Obstáculo à frente e à esquerda. Desvie pela direita.']);      // só o urgente passou, cancelando a fala em curso
});
test('[simulado][pista] app 9b. resultado nulo do modelo e erros repetidos → "Pare e aguarde", sem direção', async () => {
  let a = await pista([null]);
  try { await a.iniciar(); await sleep(900); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Não foi possível avaliar a passagem. Pare e aguarde.']); assert.equal(a.els.oDec.textContent, 'analise_insuficiente [pista experimental]');
  a = await pista([[cadC]], {}, {detectFalha: true});
  try { await a.iniciar(); await sleep(900); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Atenção: não foi possível avaliar a passagem. Pare e aguarde.']);
});
test('[simulado][pista] app 8b. sem nenhum obstáculo desde o início: silêncio; ao sumirem os obstáculos: um aviso que não afirma caminho livre', async () => {
  let a = await pista([[]]);
  try { await a.iniciar(); await sleep(700); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), []);
  a = await pista([...Array(10).fill([cadE]), ...Array(500).fill([])]);
  try { await a.iniciar(); await sleep(1500); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Obstáculo à esquerda. Siga pela direita.', 'Nenhum obstáculo reconhecido. Isso não indica caminho livre.']);
});
test('[simulado][pista] app: lados invertidos valem também no modo pista; o modo aparece como experimental na interface', async () => {
  const a = await pista([[cadE]], {lados: 'invertido'});
  try { await a.iniciar(); await sleep(700); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Obstáculo à direita. Siga pela esquerda.']);
  assert.ok(/id="avisoPista"[^>]*>\s*<strong>Modo pista controlada \(EXPERIMENTAL\)/.test(fs.readFileSync(HTML, 'utf8')) && /Pista controlada \(experimental\)/.test(fs.readFileSync(HTML, 'utf8')));
  assert.equal(a.els.avisoPista.hidden, false);
});
