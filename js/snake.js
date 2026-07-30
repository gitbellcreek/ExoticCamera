/* Exotic Camera — Snake, the way a Nokia did it.
   Monochrome LCD, one square per cell, walls are fatal. It lives behind the
   About screen and only runs while that sheet is open. */
(function (g) {
  'use strict';

  var COLS = 17, ROWS = 17;
  var LCD = '#9ead72', DIM = '#93a268', INK = '#1c2410';
  var START_MS = 190, FLOOR_MS = 90;

  var canvas = null, ctx = null, cell = 12, pad = 0;
  var snake, dir, queued, food, score, high = 0, over, timer = null, started = false;

  function cellsFree() {
    var taken = {};
    snake.forEach(function (s) { taken[s.x + ',' + s.y] = true; });
    var free = [];
    for (var y = 0; y < ROWS; y++) {
      for (var x = 0; x < COLS; x++) if (!taken[x + ',' + y]) free.push({ x: x, y: y });
    }
    return free;
  }

  function placeFood() {
    var free = cellsFree();
    food = free.length ? free[Math.floor(Math.random() * free.length)] : null;
  }

  function reset() {
    snake = [{ x: 8, y: 8 }, { x: 7, y: 8 }, { x: 6, y: 8 }];
    dir = { x: 1, y: 0 };
    queued = null;
    score = 0;
    over = false;
    started = false;
    placeFood();
    draw();
  }

  function speed() {
    return Math.max(FLOOR_MS, START_MS - score * 6);
  }

  function step() {
    if (over || !started) return;
    if (queued) { dir = queued; queued = null; }

    var head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };

    // walls are fatal, as they were on a 6110
    if (head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS) return die();
    for (var i = 0; i < snake.length; i++) {
      if (snake[i].x === head.x && snake[i].y === head.y) return die();
    }

    snake.unshift(head);
    if (food && head.x === food.x && head.y === food.y) {
      score++;
      if (g.Sound) g.Sound.tick();
      placeFood();
      restartTimer();                        // it speeds up as it grows
    } else {
      snake.pop();
    }
    draw();
  }

  function die() {
    over = true;
    stopTimer();
    if (g.Sound) g.Sound.error();
    if (score > high) {
      high = score;
      if (g.Store) g.Store.set('snakeHigh', high);
    }
    draw();
  }

  function restartTimer() {
    stopTimer();
    timer = setInterval(step, speed());
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function block(x, y, inset) {
    inset = inset || 0;
    ctx.fillRect(pad + x * cell + inset, pad + y * cell + inset,
                 cell - 1 - inset * 2, cell - 1 - inset * 2);
  }

  function draw() {
    if (!ctx) return;
    var w = canvas.width / (self.devicePixelRatio || 1);
    var h = canvas.height / (self.devicePixelRatio || 1);

    ctx.fillStyle = LCD;
    ctx.fillRect(0, 0, w, h);

    // the faint grid of unlit pixels an LCD always shows
    ctx.fillStyle = DIM;
    for (var y = 0; y < ROWS; y++) {
      for (var x = 0; x < COLS; x++) block(x, y, cell * 0.32);
    }

    ctx.fillStyle = INK;
    snake.forEach(function (s, i) { block(s.x, s.y, i === 0 ? 0 : 1); });
    if (food) block(food.x, food.y, cell * 0.18);

    ctx.font = '600 11px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'top';
    ctx.fillText('SCORE ' + score, 2, 2);
    var best = 'BEST ' + high;
    ctx.fillText(best, w - ctx.measureText(best).width - 2, 2);

    if (!started || over) {
      var lines = over ? ['GAME OVER', 'SCORE ' + score, 'tap to play again']
                       : ['SNAKE', 'swipe or arrows', 'tap to start'];
      ctx.textAlign = 'center';
      ctx.font = '700 16px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillText(lines[0], w / 2, h / 2 - 26);
      ctx.font = '600 11px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillText(lines[1], w / 2, h / 2 + 2);
      ctx.fillText(lines[2], w / 2, h / 2 + 20);
      ctx.textAlign = 'left';
    }
  }

  function turn(x, y) {
    if (!started) return;
    if (dir.x === -x && dir.y === -y) return;      // no folding back on itself
    queued = { x: x, y: y };
  }

  function begin() {
    if (over || !started) { reset(); started = true; restartTimer(); }
  }

  function size() {
    var box = canvas.parentNode.getBoundingClientRect();
    var side = Math.min(box.width - 4, 340);
    var dpr = self.devicePixelRatio || 1;
    cell = Math.floor(side / COLS);
    var px = cell * COLS;
    pad = 0;
    canvas.style.width = px + 'px';
    canvas.style.height = px + 'px';
    canvas.width = px * dpr;
    canvas.height = px * dpr;
    ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  var Snake = {
    attach: function (el) {
      canvas = el;
      var touch = null;
      canvas.addEventListener('touchstart', function (e) {
        touch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }, { passive: true });
      canvas.addEventListener('touchend', function (e) {
        if (!touch) return;
        var t = e.changedTouches[0];
        var dx = t.clientX - touch.x, dy = t.clientY - touch.y;
        touch = null;
        if (Math.abs(dx) < 18 && Math.abs(dy) < 18) return begin();   // a tap
        if (Math.abs(dx) > Math.abs(dy)) turn(dx > 0 ? 1 : -1, 0);
        else turn(0, dy > 0 ? 1 : -1);
      });
      canvas.addEventListener('click', function () { begin(); });
      reset();
    },

    keydown: function (e) {
      var k = e.key;
      if (k === 'ArrowLeft') turn(-1, 0);
      else if (k === 'ArrowRight') turn(1, 0);
      else if (k === 'ArrowUp') turn(0, -1);
      else if (k === 'ArrowDown') turn(0, 1);
      else if (k === ' ' || k === 'Enter') begin();
      else return false;
      e.preventDefault();
      return true;
    },

    open: function () {
      if (!canvas) return;
      size();
      if (g.Store) {
        g.Store.get('snakeHigh').then(function (v) {
          high = v || 0;
          draw();
        });
      }
      reset();
    },

    close: function () {
      stopTimer();
      started = false;
    },

    /** For tests. */
    state: function () {
      return { score: score, high: high, over: over, started: started,
               len: snake ? snake.length : 0, head: snake ? snake[0] : null, running: !!timer };
    },
    _feed: function () { if (snake && snake.length) food = { x: snake[0].x + dir.x, y: snake[0].y + dir.y }; }
  };

  g.Snake = Snake;
})(self);
