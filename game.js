(() => {
  'use strict';
  const canvas = document.querySelector('#game');
  const ctx = canvas.getContext('2d');
  const overlay = document.querySelector('#overlay');
  const scoreEl = document.querySelector('#score');
  const clockEl = document.querySelector('#matchClock');
  const note = document.querySelector('#queueNote');
  const size = 25;
  const cell = canvas.width / size;
  const dirs = { up:{x:0,y:-1}, down:{x:0,y:1}, left:{x:-1,y:0}, right:{x:1,y:0} };
  let snake, direction, nextDirection, food, score = 0, timer = null, startedAt = 0, clockTimer = null, running = false;

  function reset() {
    snake = [{x:12,y:12},{x:11,y:12},{x:10,y:12},{x:9,y:12}];
    direction = dirs.right; nextDirection = dirs.right; score = 0;
    scoreEl.textContent = '00'; clockEl.textContent = '00:00'; food = makeFood(); draw();
  }
  function makeFood() {
    const free = [];
    for (let y=0;y<size;y++) for (let x=0;x<size;x++) if (!snake.some(p=>p.x===x&&p.y===y)) free.push({x,y});
    return free[Math.floor(Math.random()*free.length)];
  }
  function start() {
    if (running) return;
    reset(); running = true; startedAt = Date.now(); overlay.classList.add('hidden');
    document.querySelector('#overlaySymbol').textContent = '↻';
    document.querySelector('#overlayEyebrow').textContent = 'PRACTICE RUN';
    document.querySelector('#overlayTitle').textContent = 'Run it back.';
    document.querySelector('#overlayCopy').textContent = `You grew to ${score} points. Ready for another round?`;
    document.querySelector('#startButton').innerHTML = 'Play again <span>→</span>';
    clockTimer = setInterval(()=>{const seconds=Math.floor((Date.now()-startedAt)/1000);clockEl.textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`},250);
    tick();
  }
  function tick() {
    if (!running) return;
    direction = nextDirection;
    const head = {x:snake[0].x+direction.x,y:snake[0].y+direction.y};
    const eating = head.x===food.x&&head.y===food.y;
    const body = eating ? snake : snake.slice(0,-1);
    if(head.x<0||head.y<0||head.x>=size||head.y>=size||body.some(p=>p.x===head.x&&p.y===head.y)){finish();return;}
    snake.unshift(head);
    if(eating){score++;scoreEl.textContent=String(score).padStart(2,'0');food=makeFood();}else snake.pop();
    draw(); timer=setTimeout(tick,Math.max(75,132-Math.floor(score/5)*5));
  }
  function finish(){running=false;clearTimeout(timer);clearInterval(clockTimer);document.querySelector('#overlayCopy').textContent=`You grew to ${score} points. Ready for another round?`;overlay.classList.remove('hidden');draw();}
  function setDirection(name){const d=dirs[name];if(!d||d.x===-direction.x&&d.y===-direction.y)return;nextDirection=d;}
  function draw(){
    ctx.fillStyle='#0b110e';ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.strokeStyle='rgba(135,164,139,.055)';ctx.lineWidth=1;
    for(let i=0;i<=size;i++){const p=i*cell+.5;ctx.beginPath();ctx.moveTo(p,0);ctx.lineTo(p,canvas.height);ctx.stroke();ctx.beginPath();ctx.moveTo(0,p);ctx.lineTo(canvas.width,p);ctx.stroke();}
    if(food){ctx.save();ctx.shadowColor='#c6fa72';ctx.shadowBlur=18;ctx.fillStyle='#d2ff87';ctx.beginPath();ctx.arc(food.x*cell+cell/2,food.y*cell+cell/2,cell*.29,0,Math.PI*2);ctx.fill();ctx.restore();}
    snake?.forEach((part,i)=>{ctx.fillStyle=i===0?'#d7ff98':`hsl(102 56% ${49-Math.min(i,12)*1.15}%)`;const inset=i===0?2:3;ctx.beginPath();ctx.roundRect(part.x*cell+inset,part.y*cell+inset,cell-inset*2,cell-inset*2,5);ctx.fill();});
  }
  document.querySelector('#startButton').addEventListener('click',start);
  document.querySelector('#restartButton').addEventListener('click',()=>{if(running){finish();document.querySelector('#overlayTitle').textContent='Practice paused.';}else start();});
  document.querySelector('#findButton').addEventListener('click',()=>{note.textContent='Matchmaking is not connected yet. Practice mode is ready to play.';document.querySelector('#startButton').focus();});
  document.addEventListener('keydown',e=>{const keys={ArrowUp:'up',w:'up',ArrowDown:'down',s:'down',ArrowLeft:'left',a:'left',ArrowRight:'right',d:'right'};const dir=keys[e.key];if(dir){e.preventDefault();setDirection(dir);}});
  document.querySelectorAll('[data-dir]').forEach(button=>button.addEventListener('pointerdown',e=>{e.preventDefault();setDirection(button.dataset.dir);}));
  reset();
})();
