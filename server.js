var events = require('events');
var uuid = require('node-uuid');
var mongojs = require('mongojs');
var server = exports;

STARTING_POSITIONS = {
  'CLASSIC': 'dF1,dG1,dJ1,dK1,dE2,dL2,dD3,dM3,dC4,dN4,dB5,dO5,dA6,dP6,dA7,dP7,dA9,dP9,dA10,dP10,dB11,dO11,dC12,dN12,dD13,dM13,dE14,dL14,dF15,dG15,dJ15,dK15,TG7,TH7,TJ7,TG8,TJ8,TG9,TH9,TJ9,RH8'
}

server.backend = function(socket_emitter) {
  var self = this;

  self.db = mongojs('gamesdb', ['games']);
  self.front_end = socket_emitter || new events.EventEmitter();

  self.create_game = function(dwarf_controller, troll_controller, callback) {
    var game_id = uuid.v1();
    self.db.games.save({
      game_id: game_id,
      dwarf_controller: dwarf_controller,
      troll_controller: troll_controller,
      moves: [],
      starting_positions: STARTING_POSITIONS['CLASSIC'],
      complete: false
    }, function(err, saved) {
      if (!err)
        callback(game_id);
      else
        callback(null);
    })
  }

  self.find_game = function(game_id, callback) {
    self.db.games.findOne({game_id: game_id}, function(err, games) {
      if (!err)
        callback(games);
      else
        console.error('No game found with', criteria);
    })
  }

  self.turn_to_act = function(game_obj) {
    return (game_obj.moves.length % 2 == 0 ? 'dwarf' : 'troll')
  }

  self.query = function(moves, type, callback) {
    if (['validate', 'next_move', 'captures'].indexOf(type) < 0)
      throw 'query type not permitted.'
    var exec = require('child_process').exec;
    var child = exec(__dirname + '/console.py ' + type);

    child.stdout.on('data', function(data) {
      var retval = data.toString('ascii').trim();

      if (type == 'validate')
        callback(JSON.parse(retval.toLowerCase()));
      else
        callback(retval);
    })

    child.stdin.write(moves.join('\n'));
    child.stdin.end();
  }

  self.append_move = function(game_id, move, callback) {
    function handle_validity(is_valid) {
      if (is_valid) {
        self.db.games.findAndModify({
          query: {game_id: game_id},
          update: { $push: {moves: move} }
        }, function(err) {
          callback(true);
        })
      } else {
        console.log('Game:', game_id, 'discarded invalid move:', move)
        self.db.games.findAndModify({
          query: {game_id: game_id},
          update: { $pop: {moves: 1} }
        }, function(err) {
          callback(false);
        })
      }
    }

    self.find_game(game_id, function(game) {
      game.moves.push(move);
      self.query(game.moves, 'validate', handle_validity);
    })
  }

  self.front_end.on('connection', function(socket) {
    var ip = socket['client']['conn']['remoteAddress'];
    console.log('New client connected:', ip);

    socket.on('create_game', function(data) {
      self.create_game(data.dwarf_controller, data.troll_controller, function(game_id) {
        console.log('Request to provision a new gameboard from', ip);
        console.log('Game ID:', game_id)
        socket.emit('new_game_created', {
          game_id: game_id,
          positions: STARTING_POSITIONS['CLASSIC']
        })
      })
    })

    socket.on('wait_for_cpu', function(game_id) {
      self.find_game(game_id, function(game) {
        if (self.turn_to_act(game) == 'troll' && 
            game.troll_controller == 'cpu') {
          self.query(game.moves, 'next_move', function(next_move) {
            self.append_move(game_id, next_move, function(success) {
              console.log('Game:', game_id, 'responded with', next_move, 'to', ip);
              socket.emit('cpu_response', {
                game: game_id,
                responded: next_move
              })
            });
          })
        }
      })
    })

    socket.on('attempt_move', function(data) {
      self.find_game(data.game_id, function(game) {
        self.append_move(data.game_id, data.move, function(success) {
          if (success) {
            if (data.move[0] == 'T') {
              self.query(game.moves, 'captures', function(full_capstring) {
                if (full_capstring.length > data.move.length) {
                  self.db.games.findAndModify({
                    query: {game_id: data.game_id},
                    update: { $pop: {moves: 1}}
                  }, function(err, doc, last_error) {
                    if (!err) {
                      self.db.games.findAndModify({
                        query: {game_id: data.game_id},
                        update: { $push: {moves: data.move} }
                      })
                    }
                  })
                
                  console.log('Game:', data.game_id, 'accepted move', data.move, 'from', ip);
                  socket.emit('move_accepted', {
                    game_id: data.game_id,
                    requested: data.move
                  })
                }
              })
            } else {
              console.log('Game:', data.game_id, 'accepted move', data.move, 'from', ip);
              socket.emit('move_accepted', {
                game_id: data.game_id,
                requested: data.move
              })
            }
          }

        })
      })
    })
  })

  return self;
}
