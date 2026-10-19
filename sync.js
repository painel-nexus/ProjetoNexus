/* ═══════════════════════════════════════════════════════════════════════
   sync.js — Sincronização do Painel Nexus com o Supabase
   ───────────────────────────────────────────────────────────────────────
   As páginas do painel continuam gravando e lendo no localStorage, como
   sempre fizeram. Este arquivo fica "por baixo" delas:

   1. LEITURA  — ao abrir qualquer página, baixa os dados do banco e coloca
                 no localStorage ANTES de a página começar a desenhar.
   2. GRAVAÇÃO — toda vez que uma página salva uma das chaves do Nexus no
                 localStorage, a alteração é enviada também para o banco.
   3. LOGIN    — a página admin exige usuário e senha. Sem login, as demais
                 páginas ficam somente leitura (os botões de edição somem).

   Deve ser o PRIMEIRO script do <head> de cada página:
     <script src="sync.js"></script>                    (páginas de leitura)
     <script src="sync.js" data-modo="admin"></script>  (admin.html)
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ═══════════════════════════════════════════════
  // CONFIGURAÇÃO — preencha com os dados do seu projeto Supabase
  // (Project Settings → Data API / API Keys)
  // ═══════════════════════════════════════════════
  var SUPABASE_URL = 'https://qshqeintqkpdazeqvivn.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_RkUU1JqCI3QX45VkogdCRw_02gE1uhb';

  // true  = qualquer pessoa com o link vê o painel; só quem tem login edita
  // false = é preciso login até para visualizar (troque também a política
  //         de leitura no SQL, conforme indicado lá)
  var LEITURA_PUBLICA = false;

  // ═══════════════════════════════════════════════
  // CONSTANTES
  // ═══════════════════════════════════════════════
  var TABELA = 'nexus_kv';
  // Únicas chaves sincronizadas. Qualquer outra chave do localStorage
  // (ex.: nexus_pre_import) continua só local, como antes.
  var CHAVES = [
    'nexus_dados', 'nexus_historico', 'nexus_estrutura',
    'nexus_central_dados', 'nexus_revenue_sprints',
    'nexus_consolidado_override', 'nexus_progresso'
  ];
  var SESSAO_KEY = 'nexus_sb_session';
  var RELOAD_FLAG = 'nexus_sync_reload';

  var script = document.currentScript;
  var MODO = (script && script.getAttribute('data-modo')) || 'leitura';
  var CONFIGURADO = SUPABASE_URL.indexOf('SEU-PROJETO') === -1 &&
                    SUPABASE_KEY.indexOf('COLE_AQUI') === -1;
  SUPABASE_URL = SUPABASE_URL.replace(/\/+$/, '');

  var ls;
  try { ls = window.localStorage; } catch (e) { ls = null; }
  if (!ls) return;  // navegador sem localStorage: as páginas já tratam isso

  var origSet = Storage.prototype.setItem;
  var origRemove = Storage.prototype.removeItem;
  var origGet = Storage.prototype.getItem;

  // ═══════════════════════════════════════════════
  // SESSÃO (login)
  // ═══════════════════════════════════════════════
  function lerSessao() {
    try { var s = origGet.call(ls, SESSAO_KEY); return s ? JSON.parse(s) : null; }
    catch (e) { return null; }
  }
  function gravarSessao(s) {
    try {
      if (s) origSet.call(ls, SESSAO_KEY, JSON.stringify(s));
      else origRemove.call(ls, SESSAO_KEY);
    } catch (e) {}
  }
  function normSessao(r, emailAnterior) {
    return {
      access_token: r.access_token,
      refresh_token: r.refresh_token,
      expires_at: r.expires_at || (Math.floor(Date.now() / 1000) + (r.expires_in || 3600)),
      email: (r.user && r.user.email) || emailAnterior || ''
    };
  }
  function expirando(s) {
    return !s || (s.expires_at - Math.floor(Date.now() / 1000)) < 60;
  }

  // ═══════════════════════════════════════════════
  // HTTP
  // ═══════════════════════════════════════════════
  // Síncrono: usado só no carregamento, para os dados estarem no
  // localStorage antes de os scripts da página rodarem.
  function xhrSync(method, path, body, token) {
    var x = new XMLHttpRequest();
    x.open(method, SUPABASE_URL + path, false);
    x.setRequestHeader('apikey', SUPABASE_KEY);
    if (token) x.setRequestHeader('Authorization', 'Bearer ' + token);
    if (body) x.setRequestHeader('Content-Type', 'application/json');
    x.send(body ? JSON.stringify(body) : null);
    if (x.status < 200 || x.status >= 300) {
      var e = new Error('HTTP ' + x.status); e.status = x.status; throw e;
    }
    return x.responseText ? JSON.parse(x.responseText) : null;
  }

  function req(method, path, body, token, extra) {
    var h = { 'apikey': SUPABASE_KEY };
    if (token) h['Authorization'] = 'Bearer ' + token;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (extra) for (var k in extra) h[k] = extra[k];
    var corpo = body !== undefined ? JSON.stringify(body) : undefined;
    return fetch(SUPABASE_URL + path, {
      method: method, headers: h, body: corpo,
      // keepalive deixa a gravação terminar mesmo se a página for fechada
      // logo após salvar (limite do navegador: ~64 KB por envio)
      keepalive: !!corpo && corpo.length < 60000
    }).then(function (r) {
      return r.text().then(function (t) {
        if (!r.ok) { var e = new Error('HTTP ' + r.status + ' ' + t); e.status = r.status; throw e; }
        return t ? JSON.parse(t) : null;
      });
    });
  }

  // Devolve um access_token válido (renovando se preciso) ou null
  function tokenValido() {
    var s = lerSessao();
    if (!s) return Promise.resolve(null);
    if (!expirando(s)) return Promise.resolve(s.access_token);
    return req('POST', '/auth/v1/token?grant_type=refresh_token', { refresh_token: s.refresh_token })
      .then(function (r) { var n = normSessao(r, s.email); gravarSessao(n); return n.access_token; })
      .catch(function (e) {
        if (e.status === 400 || e.status === 401) gravarSessao(null);
        return null;
      });
  }

  // ═══════════════════════════════════════════════
  // APLICAR DADOS DO BANCO NO localStorage
  // ═══════════════════════════════════════════════
  // O banco é a fonte oficial: o que existe lá substitui a cópia local, e
  // chaves que não existem lá são removidas daqui.
  function aplicarRemoto(linhas) {
    var mapa = {}, mudou = false;
    (linhas || []).forEach(function (l) { mapa[l.key] = l.value; });
    CHAVES.forEach(function (k) {
      var atual = origGet.call(ls, k);
      if (Object.prototype.hasOwnProperty.call(mapa, k)) {
        if (atual !== mapa[k]) { origSet.call(ls, k, mapa[k]); mudou = true; }
      } else if (atual !== null) {
        origRemove.call(ls, k); mudou = true;
      }
    });
    return mudou;
  }

  function recarregarUmaVez() {
    try {
      var ult = parseInt(sessionStorage.getItem(RELOAD_FLAG) || '0', 10);
      if (Date.now() - ult < 15000) return;   // evita laço de recarga
      sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
    } catch (e) {}
    location.reload();
  }

  // ═══════════════════════════════════════════════
  // CARREGAMENTO INICIAL
  // ═══════════════════════════════════════════════
  var estado = CONFIGURADO ? 'ok' : 'naoconfig';
  var sessao = lerSessao();

  if (CONFIGURADO && sessao && expirando(sessao)) {
    try {
      sessao = normSessao(xhrSync('POST', '/auth/v1/token?grant_type=refresh_token',
        { refresh_token: sessao.refresh_token }), sessao.email);
      gravarSessao(sessao);
    } catch (e) {
      // 400/401 = sessão inválida; outros erros (rede) mantêm a sessão
      if (e.status === 400 || e.status === 401) { sessao = null; gravarSessao(null); }
    }
  }

  var logado = !!sessao;
  var precisaLogin = MODO === 'admin' || !LEITURA_PUBLICA;

  if (!logado) document.documentElement.classList.add('nexus-anon');

  // Painel fechado (LEITURA_PUBLICA = false) e ninguém logado: apaga qualquer
  // cópia local dos dados, para nada ficar guardado neste navegador.
  function limparDadosLocais() {
    CHAVES.forEach(function (k) { try { origRemove.call(ls, k); } catch (e) {} });
  }
  if (CONFIGURADO && !LEITURA_PUBLICA && !logado) limparDadosLocais();

  if (CONFIGURADO && (!precisaLogin || logado)) {
    var tokenLeitura = logado ? sessao.access_token : null;
    var caminhoLeitura = '/rest/v1/' + TABELA + '?select=key,value';
    try {
      aplicarRemoto(xhrSync('GET', caminhoLeitura, null, tokenLeitura));
      try { sessionStorage.removeItem(RELOAD_FLAG); } catch (e) {}
    } catch (e) {
      // Plano B: busca assíncrona. Se vier algo diferente do cache local,
      // recarrega a página uma vez para desenhar com os dados certos.
      estado = 'cache';
      req('GET', caminhoLeitura, undefined, tokenLeitura)
        .then(function (linhas) {
          estado = 'ok';
          if (aplicarRemoto(linhas)) recarregarUmaVez(); else atualizarBadge();
        })
        .catch(function () { estado = 'offline'; atualizarBadge(); });
    }
  }

  // ═══════════════════════════════════════════════
  // GRAVAÇÃO: intercepta o localStorage
  // ═══════════════════════════════════════════════
  var pendentes = {};      // chave -> { v: valor | null (remoção) }
  var timer = null;
  var enviando = null;
  var tentativas = 0;

  Storage.prototype.setItem = function (k, v) {
    origSet.call(this, k, v);
    if (this === ls && CHAVES.indexOf(k) !== -1) enfileirar(k, String(v));
  };
  Storage.prototype.removeItem = function (k) {
    origRemove.call(this, k);
    if (this === ls && CHAVES.indexOf(k) !== -1) enfileirar(k, null);
  };

  function enfileirar(k, v) {
    if (!CONFIGURADO) return;
    if (!lerSessao()) { setEstado('semlogin'); return; }
    pendentes[k] = { v: v };
    setEstado('salvando');
    agendar(80);
  }

  function agendar(ms) {
    clearTimeout(timer);
    timer = setTimeout(function () { flush().catch(function () {}); }, ms);
  }

  function temPendente() { return Object.keys(pendentes).length > 0; }

  // Envia tudo o que está pendente. Devolve uma Promise.
  function flush() {
    clearTimeout(timer); timer = null;
    if (enviando) {
      return enviando.then(function () { return temPendente() ? flush() : null; },
                           function () { return temPendente() ? flush() : null; });
    }
    if (!temPendente()) return Promise.resolve();

    var lote = pendentes; pendentes = {};
    var chaves = Object.keys(lote);
    var email = (lerSessao() || {}).email || '';
    var agora = new Date().toISOString();
    var upserts = [], deletes = [];
    chaves.forEach(function (k) {
      if (lote[k].v === null) deletes.push(k);
      else upserts.push({ key: k, value: lote[k].v, updated_at: agora, updated_by: email });
    });

    enviando = tokenValido().then(function (token) {
      if (!token) { var e = new Error('sem sessão'); e.status = 401; throw e; }
      var ops = [];
      if (upserts.length) {
        ops.push(req('POST', '/rest/v1/' + TABELA, upserts, token,
          { 'Prefer': 'resolution=merge-duplicates,return=minimal' }));
      }
      if (deletes.length) {
        ops.push(req('DELETE', '/rest/v1/' + TABELA + '?key=in.(' + deletes.join(',') + ')',
          undefined, token, { 'Prefer': 'return=minimal' }));
      }
      return Promise.all(ops);
    }).then(function () {
      tentativas = 0;
      enviando = null;
      setEstado(temPendente() ? 'salvando' : 'salvo');
      if (temPendente()) return flush();
    }, function (err) {
      enviando = null;
      // Devolve o lote à fila sem sobrescrever alterações mais novas
      chaves.forEach(function (k) { if (!(k in pendentes)) pendentes[k] = lote[k]; });
      if (err.status === 401 || err.status === 403) {
        setEstado('sessao');
        if (MODO === 'admin') mostrarLogin('Sua sessão expirou. Entre novamente para salvar.');
      } else {
        tentativas++;
        setEstado('erro');
        if (tentativas <= 6) agendar(Math.min(30000, 2000 * tentativas));
      }
      throw err;
    });
    return enviando;
  }

  // Avisa antes de fechar a página se ainda há algo não enviado
  window.addEventListener('beforeunload', function (ev) {
    if (temPendente() || enviando) { ev.preventDefault(); ev.returnValue = ''; }
  });

  // ═══════════════════════════════════════════════
  // INTERFACE: estilo, selo de status e tela de login
  // ═══════════════════════════════════════════════
  var css = [
    // Sem login: some com os botões de edição das telas de gráfico
    'html.nexus-anon .btn-add-dados, html.nexus-anon .btn-edit-dados,',
    'html.nexus-anon .btn-add, html.nexus-anon .btn-edit,',
    'html.nexus-anon .col-acoes, html.nexus-anon .row-actions { display: none !important; }',
    '#nx-badge { position: fixed; left: 12px; bottom: 12px; z-index: 99998; display: none;',
    '  align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px;',
    '  font: 600 11px/1.2 "Segoe UI", Inter, Arial, sans-serif; color: #e2e8f0;',
    '  background: rgba(15,23,42,.94); border: 1px solid #334155;',
    '  box-shadow: 0 6px 18px rgba(0,0,0,.4); }',
    '#nx-badge .nx-dot { width: 8px; height: 8px; border-radius: 50%; background: #64748b; flex-shrink: 0; }',
    '#nx-badge.ok .nx-dot, #nx-badge.salvo .nx-dot { background: #22c55e; }',
    '#nx-badge.salvando .nx-dot { background: #60a5fa; }',
    '#nx-badge.erro .nx-dot, #nx-badge.sessao .nx-dot, #nx-badge.offline .nx-dot { background: #ef4444; }',
    '#nx-badge.cache .nx-dot, #nx-badge.semlogin .nx-dot, #nx-badge.naoconfig .nx-dot { background: #eab308; }',
    '#nx-badge button { background: none; border: 1px solid #334155; color: #94a3b8; border-radius: 6px;',
    '  padding: 2px 8px; font: inherit; cursor: pointer; }',
    '#nx-badge button:hover { color: #e2e8f0; border-color: #3b82f6; }',
    '#nx-login { position: fixed; inset: 0; z-index: 99999; display: flex; align-items: center;',
    '  justify-content: center; padding: 20px; background: rgba(3,8,17,.88); backdrop-filter: blur(4px);',
    '  font-family: "Segoe UI", Inter, Arial, sans-serif; }',
    // Painel fechado: fundo totalmente opaco, nada aparece por trás do login
    '#nx-login.nx-fechado { background: #030811; backdrop-filter: none; }',
    '#nx-login form { width: 100%; max-width: 360px; background: #111827; border: 1px solid #334155;',
    '  border-radius: 14px; padding: 26px; color: #e2e8f0; box-shadow: 0 20px 50px rgba(0,0,0,.5); }',
    '#nx-login h2 { font-size: 17px; font-weight: 800; margin: 0 0 4px; }',
    '#nx-login p { font-size: 12px; color: #94a3b8; margin: 0 0 18px; line-height: 1.5; }',
    '#nx-login label { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 1px;',
    '  color: #94a3b8; margin: 0 0 5px; }',
    '#nx-login input { width: 100%; box-sizing: border-box; background: #1e293b; border: 1px solid #334155;',
    '  color: #e2e8f0; padding: 10px 12px; border-radius: 8px; font-size: 14px; margin: 0 0 14px; font-family: inherit; }',
    '#nx-login input:focus { outline: 1px solid #3b82f6; border-color: #3b82f6; }',
    '#nx-login button { width: 100%; background: #3b82f6; color: #fff; border: none; border-radius: 8px;',
    '  padding: 11px; font-size: 13px; font-weight: 700; cursor: pointer; font-family: inherit; }',
    '#nx-login button:disabled { opacity: .6; cursor: wait; }',
    '#nx-login .nx-erro { color: #f87171; font-size: 12px; min-height: 16px; margin: 10px 0 0; }',
    '#nx-login a { color: #60a5fa; font-size: 12px; display: inline-block; margin-top: 14px; }',
    '@media print { #nx-badge, #nx-login { display: none !important; } }'
  ].join('\n');
  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  (document.head || document.documentElement).appendChild(styleEl);

  var TEXTOS = {
    ok:        function () { return 'Conectado'; },
    salvo:     function () { return 'Salvo no servidor'; },
    salvando:  function () { return 'Salvando…'; },
    erro:      function () { return 'Falha ao salvar — tentando de novo'; },
    sessao:    function () { return 'Sessão expirada — entre novamente'; },
    cache:     function () { return 'Conectando ao servidor…'; },
    offline:   function () { return 'Sem conexão com o servidor — exibindo cópia local'; },
    semlogin:  function () { return 'Alteração não salva no servidor — entre pelo Admin'; },
    naoconfig: function () { return 'sync.js sem configuração — dados só neste navegador'; }
  };

  function setEstado(e) { estado = e; atualizarBadge(); }

  var badge = null;
  function atualizarBadge() {
    if (!document.body) return;
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'nx-badge';
      document.body.appendChild(badge);
    }
    var s = lerSessao();
    // Visitante sem login com tudo certo: não mostra nada
    var mostrar = !!s || ['offline', 'semlogin', 'naoconfig', 'erro'].indexOf(estado) !== -1;
    if (estado === 'cache' && !s) mostrar = false;
    badge.style.display = mostrar ? 'flex' : 'none';
    badge.className = estado;
    var html = '<span class="nx-dot"></span><span>' + TEXTOS[estado]() + '</span>';
    if (s) {
      html += '<span style="color:#64748b">· ' + escapar(s.email) + '</span>' +
              '<button type="button" data-nx="sair">Sair</button>';
    }
    badge.innerHTML = html;
    var btn = badge.querySelector('[data-nx="sair"]');
    if (btn) btn.onclick = sair;
    if (estado === 'salvo') {
      setTimeout(function () { if (estado === 'salvo') setEstado('ok'); }, 2500);
    }
  }

  function escapar(t) {
    return String(t || '').replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function mostrarLogin(msg) {
    if (document.getElementById('nx-login')) return;
    var box = document.createElement('div');
    box.id = 'nx-login';
    if (!LEITURA_PUBLICA) box.className = 'nx-fechado';
    box.innerHTML =
      '<form autocomplete="on">' +
      '  <h2>Projeto Nexus</h2>' +
      '  <p>' + escapar(msg || (MODO === 'admin'
              ? 'Entre com seu usuário para atualizar os dados do painel.'
              : 'Entre com seu usuário para visualizar o painel.')) + '</p>' +
      '  <label for="nx-email">E-mail</label>' +
      '  <input id="nx-email" type="email" autocomplete="username" required/>' +
      '  <label for="nx-senha">Senha</label>' +
      '  <input id="nx-senha" type="password" autocomplete="current-password" required/>' +
      '  <button type="submit">Entrar</button>' +
      '  <div class="nx-erro" id="nx-erro"></div>' +
      (MODO === 'admin' && LEITURA_PUBLICA ? '  <a href="painel-nexus.html">← Ver o painel sem entrar</a>' : '') +
      '</form>';
    document.body.appendChild(box);
    var form = box.querySelector('form');
    var erro = box.querySelector('#nx-erro');
    var botao = box.querySelector('button');
    setTimeout(function () { box.querySelector('#nx-email').focus(); }, 50);

    form.onsubmit = function (ev) {
      ev.preventDefault();
      erro.textContent = '';
      botao.disabled = true; botao.textContent = 'Entrando…';
      req('POST', '/auth/v1/token?grant_type=password', {
        email: box.querySelector('#nx-email').value.trim(),
        password: box.querySelector('#nx-senha').value
      }).then(function (r) {
        gravarSessao(normSessao(r));
        // Se havia algo esperando para ser salvo, envia antes de recarregar
        return (temPendente() ? flush() : Promise.resolve()).then(function () {
          location.reload();
        });
      }).catch(function (e) {
        botao.disabled = false; botao.textContent = 'Entrar';
        erro.textContent = (e.status === 400)
          ? 'E-mail ou senha inválidos.'
          : 'Não foi possível conectar ao servidor. Tente novamente.';
      });
    };
  }

  function sair() {
    var fim = function () {
      gravarSessao(null);
      if (!LEITURA_PUBLICA) limparDadosLocais();
      location.reload();
    };
    var s = lerSessao();
    (temPendente() ? flush() : Promise.resolve())
      .catch(function () {})
      .then(function () {
        if (!s) return;
        return req('POST', '/auth/v1/logout', {}, s.access_token).catch(function () {});
      })
      .then(fim, fim);
  }

  function aoCarregarDom() {
    atualizarBadge();
    if (CONFIGURADO && precisaLogin && !logado) mostrarLogin();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', aoCarregarDom);
  else aoCarregarDom();

  // ═══════════════════════════════════════════════
  // API pública (usada pelo admin no Importar backup)
  // ═══════════════════════════════════════════════
  window.NexusSync = {
    flush: flush,
    sair: sair,
    logado: function () { return !!lerSessao(); },
    configurado: CONFIGURADO
  };
})();
