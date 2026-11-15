(() => {
  'use strict';

  const canvas = document.querySelector('#game');
  const ctx = canvas.getContext('2d');
  const overlay = document.querySelector('#overlay');
  const startButton = document.querySelector('#startButton');
  const findButton = document.querySelector('#findButton');
  const queueNote = document.querySelector('#queueNote');
  const matchbar = document.querySelector('.matchbar');
  const connectionState = document.querySelector('#connectionState');
  const scoreEls = [document.querySelector('#score'), document.querySelector('#opponentScore')];
  const size = 25;
  const cell = canvas.width / size;
  const SERVER_URL = window.SNAKE_DUEL_SERVER_URL || (location.hostname === 'localhost' ? 'ws://localhost:10000/ws' : '');
  const directions = { up:{x:0,y:-1}, down:{x:0,y:1}, left:{x:-1,y:0}, right:{x:1,y:0} };
  const reverse = new Map([[directions.up,directions.down],[directions.down,directions.up],[directions.left,directions.right],[directions.right,directions.left]]);
  const colors = ['#d2ff87','#ff8c86'];

  let socket = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  let shouldConnect = true;
  let playerId = getPlayerId();
  let playerName = getPlayerName();
  let playerIndex = 0;
  let phase = 'idle';
  let wantsQueue = false;
  let intentionallyLeaving = false;
  let snapshot = null;
  let elapsedSeconds = 0;
  let clockTimer = null;
  let seatColorCopy = '';

  function getPlayerId() {
    try {
      let id = sessionStorage.getItem('snakeDuelGuestId');
      if (!id) { id = crypto.randomUUID(); sessionStorage.setItem('snakeDuelGuestId', id); }
      return id;
    } catch { return crypto.randomUUID(); }
  }

  function getPlayerName() {
    const names = ['LimeFox','MintDash','QuickTail','NightOwl','GreenComet','SwiftSnake'];
    return `${names[Math.floor(Math.random()*names.length)]}-${Math.floor(10+Math.random()*90)}`;
  }

  function setConnection(kind, text) {
    connectionState.classList.remove('is-online','is-offline','is-searching');
    connectionState.classList.add(kind === 'online' ? 'is-online' : kind === 'searching' ? 'is-searching' : 'is-offline');
    connectionState.lastChild.textContent = ` ${text}`;
  }

  function setStatus(message, searching = false) {
    queueNote.classList.toggle('is-searching', searching);
    queueNote.innerHTML = `<span class="queue-icon">${searching ? '◷' : '✳'}</span> ${message}`;
  }

  function showOverlay(kicker, title, copy, symbol = '⚔', buttonText = 'Find a free duel') {
    document.querySelector('#overlaySymbol').textContent = symbol;
    document.querySelector('#overlayEyebrow').textContent = kicker;
    document.querySelector('#overlayTitle').textContent = title;
    document.querySelector('#overlayCopy').textContent = copy;
    startButton.innerHTML = `${buttonText} <span>→</span>`;
    overlay.classList.remove('hidden');
  }

  function send(data) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
  }

  function connect() {
    if (!SERVER_URL) {
      setConnection('offline','SERVER NOT SET');
      setStatus('Game server URL is not set yet.');
      return;
    }
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    setConnection('searching','CONNECTING');
    try { socket = new WebSocket(SERVER_URL); }
    catch { setConnection('offline','OFFLINE'); scheduleReconnect(); return; }

    socket.addEventListener('open', () => {
      reconnectDelay = 1000;
      setConnection('online','ONLINE');
      send({ type:'hello', playerId, name:playerName });
      setStatus('Connected. Find an opponent to enter the queue.');
      if (wantsQueue) { wantsQueue = false; send({type:'join_queue', name:playerName}); }
    });
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      handleMessage(message);
    });
    socket.addEventListener('error', () => setConnection('offline','CONNECTION ERROR'));
    socket.addEventListener('close', () => {
      socket = null;
      clearInterval(clockTimer);
      const wasInMatch = phase === 'playing' || phase === 'countdown';
      phase = 'idle'; snapshot = null; updateButtons();
      setConnection('offline','OFFLINE');
      if (wasInMatch) showOverlay('CONNECTION LOST','Match ended.','The connection closed. Find another free duel when you are ready.','↻');
      setStatus('Trying to reconnect…', true);
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (!shouldConnect || reconnectTimer || !SERVER_URL) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
      reconnectDelay = Math.min(reconnectDelay * 1.8, 10000);
    }, reconnectDelay);
  }

  function handleMessage(message) {
    switch (message.type) {
      case 'welcome':
        if (message.playerId) playerId = message.playerId;
        break;
      case 'queue':
        phase = 'queued'; updateButtons(); setConnection('searching','FINDING MATCH');
        overlay.classList.add('hidden');
        setStatus('Looking for another player… You can cancel any time.', true);
        document.querySelector('#modeLabel').textContent = 'FREE DUEL · QUEUE';
        break;
      case 'queue_cancelled':
        phase = 'idle'; updateButtons(); setConnection('online','ONLINE');
        setStatus('Search cancelled. Find an opponent when ready.');
        document.querySelector('#modeLabel').textContent = 'FREE DUEL · IDLE';
        showOverlay('FREE MATCHMAKING','Find your opponent.','Join the queue and get matched with another player online.');
        break;
      case 'match_found':
        phase = 'countdown'; playerIndex = message.playerIndex;
        const selfName = message.players[playerIndex].name;
        const opponentName = message.players[1-playerIndex].name;
        const selfColor = colors[playerIndex];
        const opponentColor = colors[1-playerIndex];
        const colorNames = ['lime green','coral pink'];
        document.querySelector('#selfName').textContent = selfName;
        document.querySelector('#selfCaption').textContent = 'YOUR SNAKE';
        document.querySelector('#selfCaption').style.setProperty('--snake-color',selfColor);
        document.querySelector('#selfCaption').classList.add('color-known');
        document.querySelector('#selfAvatar').textContent = selfName.slice(0,1).toUpperCase();
        document.querySelector('#selfAvatar').style.color = selfColor;
        document.querySelector('#selfAvatar').style.borderColor = selfColor;
        document.querySelector('#opponentName').textContent = opponentName.toUpperCase();
        document.querySelector('#opponentName').style.setProperty('--snake-color',opponentColor);
        document.querySelector('#opponentName').classList.add('color-known');
        scoreEls[0].style.color = selfColor;
        scoreEls[1].style.color = opponentColor;
        seatColorCopy = `Your snake is ${colorNames[playerIndex]}; ${opponentName}'s snake is ${colorNames[1-playerIndex]}.`;
        setStatus(`Matched with ${opponentName}. Get ready!`);
        updateButtons();
        document.querySelector('#modeLabel').textContent = 'OPPONENT FOUND';
        matchbar.classList.add('is-countdown');
        showOverlay('OPPONENT FOUND','Get ready!',seatColorCopy,'✳','Starting…');
        startButton.disabled = true;
        break;
      case 'countdown':
        phase = 'countdown';
        document.querySelector('#overlayTitle').textContent = String(message.seconds);
        document.querySelector('#overlayCopy').textContent = seatColorCopy || 'Take your starting position.';
        break;
      case 'match_start':
        phase = 'playing'; snapshot = message.state; elapsedSeconds = 0;
        overlay.classList.add('hidden'); matchbar.classList.remove('is-countdown'); matchbar.classList.add('is-live');
        document.querySelector('#modeLabel').textContent = 'LIVE FREE DUEL';
        setStatus('Duel live. Collect fruit and stay alive.');
        clearInterval(clockTimer);
        clockTimer = setInterval(() => { elapsedSeconds++; updateClock(); },1000);
        draw(); updateScores(); updateClock(); updateButtons();
        break;
      case 'state':
        snapshot = message.state; phase = 'playing'; draw(); updateScores(); updateClock();
        break;
      case 'match_over':
        if (intentionallyLeaving) { intentionallyLeaving = false; break; }
        phase = 'finished'; snapshot = message.state || snapshot;
        clearInterval(clockTimer); draw(); updateScores(); matchbar.classList.remove('is-live','is-countdown');
        document.querySelector('#modeLabel').textContent = 'DUEL COMPLETE';
        updateButtons();
        if (message.winner === null) {
          showOverlay('DRAW','Both snakes are out.','That was close. Queue up for another free duel.','↻','Play again');
          setStatus('Draw match. Both snakes crashed in the same tick.');
        } else if (message.winner === playerIndex) {
          showOverlay('YOU WIN','Last snake standing.','Nice run. Find another opponent for a rematch.','✳','Play again');
          setStatus('Victory. Your opponent is out.');
        } else {
          showOverlay('MATCH OVER','Your opponent wins.','Queue again when you are ready for another duel.','↻','Play again');
          setStatus('Defeat. Find another opponent for a rematch.');
        }
        break;
      case 'opponent_left':
        phase = 'finished'; clearInterval(clockTimer); updateButtons();
        showOverlay('OPPONENT LEFT','You win by forfeit.','Your opponent disconnected. Find another free duel.','✳','Play again');
        setStatus('Opponent disconnected. Victory awarded by forfeit.');
        document.querySelector('#modeLabel').textContent = 'DUEL COMPLETE';
        break;
      case 'error':
        setStatus(message.message || 'Something went wrong.');
        break;
      case 'pong':
        break;
    }
  }

  function updateButtons() {
    const isQueued = phase === 'queued';
    const inMatch = phase === 'countdown' || phase === 'playing';
    findButton.disabled = inMatch;
    findButton.innerHTML = isQueued ? 'Cancel search <span>×</span>' : 'Find opponent <span>↗</span>';
    startButton.disabled = phase === 'countdown' || phase === 'playing';
  }

  function enterQueue() {
    if (phase === 'queued') { send({type:'cancel_queue'}); return; }
    if (phase === 'finished') { phase = 'idle'; snapshot = null; matchbar.classList.remove('is-live','is-countdown'); }
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      connect();
      if (SERVER_URL) wantsQueue = true;
      setStatus(SERVER_URL ? 'Connecting to the match server…' : 'Set the game server URL in config.js first.');
      return;
    }
    send({type:'join_queue', name:playerName});
    setConnection('searching','FINDING MATCH');
    setStatus('Looking for another player… You can cancel any time.', true);
    findButton.disabled = true;
  }

  function sendTurn(name) {
    if (phase !== 'playing' || !directions[name]) return;
    const dir = directions[name];
    const current = snapshot?.snakes?.[playerIndex]?.direction;
    if (current && dir.x === -current.x && dir.y === -current.y) return;
    send({type:'turn', direction:name});
  }

  function updateScores() {
    if (!snapshot?.scores) return;
    scoreEls[0].textContent = String(snapshot.scores[playerIndex] ?? 0).padStart(2,'0');
    scoreEls[1].textContent = String(snapshot.scores[1-playerIndex] ?? 0).padStart(2,'0');
    updatePace();
  }

  function updatePace() {
    const speeds = snapshot?.speedMultipliers;
    if (!Array.isArray(speeds)) return;
    const selfSpeed = Number(speeds[playerIndex] || 1).toFixed(1);
    const opponentSpeed = Number(speeds[1-playerIndex] || 1).toFixed(1);
    document.querySelector('#matchPace').textContent = `PACE ${selfSpeed}× / ${opponentSpeed}×`;
  }

  function updateClock() {
    if (snapshot?.elapsedSeconds !== undefined) elapsedSeconds = snapshot.elapsedSeconds;
    document.querySelector('#matchClock').textContent = `${String(Math.floor(elapsedSeconds/60)).padStart(2,'0')}:${String(elapsedSeconds%60).padStart(2,'0')}`;
  }

  function draw() {
    ctx.fillStyle = '#0b110e'; ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.strokeStyle = 'rgba(135,164,139,.055)'; ctx.lineWidth=1;
    for(let i=0;i<=size;i++){const p=i*cell+.5;ctx.beginPath();ctx.moveTo(p,0);ctx.lineTo(p,canvas.height);ctx.stroke();ctx.beginPath();ctx.moveTo(0,p);ctx.lineTo(canvas.width,p);ctx.stroke();}
    if (!snapshot) { updateScores(); return; }
    if(snapshot.food){ctx.save();ctx.shadowColor='#d7ff98';ctx.shadowBlur=18;ctx.fillStyle='#e0ffb3';ctx.beginPath();ctx.arc(snapshot.food.x*cell+cell/2,snapshot.food.y*cell+cell/2,cell*.29,0,Math.PI*2);ctx.fill();ctx.restore();}
    snapshot.snakes?.forEach((snake,player)=>snake.body.forEach((part,index)=>{
      ctx.fillStyle = index===0 ? colors[player] : (player===0 ? `hsl(89 72% ${52-Math.min(index,12)*1.05}%)` : `hsl(5 80% ${67-Math.min(index,12)*1.05}%)`);
      const inset=index===0?2:3;ctx.beginPath();ctx.roundRect(part.x*cell+inset,part.y*cell+inset,cell-inset*2,cell-inset*2,5);ctx.fill();
    }));
  }

  findButton.addEventListener('click', enterQueue);
  startButton.addEventListener('click', enterQueue);
  document.querySelector('#restartButton').addEventListener('click', () => {
    if (phase === 'queued') { send({type:'cancel_queue'}); return; }
    if (phase === 'playing' || phase === 'countdown') { intentionallyLeaving=true; send({type:'leave_match'}); phase='idle'; snapshot=null; clearInterval(clockTimer); }
    showOverlay('FREE MATCHMAKING','Find your opponent.','Join the queue and get matched with another player online.');
    matchbar.classList.remove('is-live','is-countdown');
    document.querySelector('#modeLabel').textContent='FREE DUEL · IDLE';
    setStatus('Ready when you are.'); updateButtons(); draw();
  });

  document.addEventListener('keydown', event => {
    const keys = {ArrowUp:'up',w:'up',W:'up',ArrowDown:'down',s:'down',S:'down',ArrowLeft:'left',a:'left',A:'left',ArrowRight:'right',d:'right',D:'right'};
    const direction = keys[event.key];
    if(direction){event.preventDefault();sendTurn(direction);}
  });
  document.querySelectorAll('[data-dir]').forEach(button => button.addEventListener('pointerdown',event=>{event.preventDefault();sendTurn(button.dataset.dir);}));
  window.addEventListener('beforeunload',()=>{shouldConnect=false;send({type:'leave_match'});socket?.close();});
  setInterval(()=>send({type:'ping'}),20000);
  draw(); updateButtons(); connect();
})();

