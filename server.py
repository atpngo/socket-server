import socketio
from aiohttp import web
import random
import string
import requests
import time
import asyncio


# Exceptions
class InvalidRoom(Exception):
    pass


class InvalidPlayer(Exception):
    pass


class APIConnectionError(Exception):
    pass


# Enums
class RoomState:
    NOT_ENOUGH_PLAYERS = 0
    READY_TO_BEGIN = 1
    WAITING_FOR_PLAYERS_TO_READY = 2
    IN_GAME = 3


# Contians utility functions
class Util:
    def get_code(length=4):
        return "".join(random.choices(string.ascii_uppercase, k=length))

    def generate_unique_code(existing_codes: set):
        code = Util.get_code()
        while code in existing_codes:
            code = Util.get_code()
        return code

    def shuffle_string(string: str):
        return "".join(random.sample(string, len(string)))


class WordsAPI:
    def __init__(self, root_url):
        self.root_url = root_url

    def get_random_word(self, length=6):
        response = requests.post(f"{self.root_url}/api/words", json={"length": length})
        if response.status_code == 200:
            res = response.json()
            words = res["words"]
            # Get random word and shuffle it
            return Util.shuffle_string(random.choice(words))
        else:
            return None

    def get_anagrams_of_word(self, word):
        response = requests.post(
            f"{self.root_url}/api/anagrams/letters", json={"letters": word}
        )
        if response.status_code == 200:
            res = response.json()
            return res["words"]
        else:
            return None


class Player:
    def __init__(self, id):
        self.id = id
        self.roomID = None
        self.latency = 0
        self.ping_start = None
        self.reset()

    def reset(self):
        self.score = 0
        self.words_found = set()
        self.is_ready = False

    def get_id(self):
        return self.id

    def get_roomID(self):
        return self.roomID

    def set_roomID(self, id):
        self.roomID = id

    def get_score(self):
        return self.score

    def set_score(self, score):
        self.score = score

    def get_ready_state(self):
        return self.is_ready

    def set_ready_state(self, state):
        self.is_ready = state

    def add_word(self, word):
        self.words_found.add(word)

    def get_words(self) -> list:
        return list(self.words_found)

    def set_words(self, words):
        self.words_found = set(words)

    def get_latency(self):
        return self.latency

    def set_latency(self, latency):
        self.latency = latency

    def get_ping_start(self):
        return self.ping_start

    def set_ping_start(self, ping_start):
        self.ping_start = ping_start


class Room:
    def __init__(self, id, max_players):
        self.id = id
        self.max_players = max_players
        # Contains a set of player IDs
        self.players = set()

    def get_id(self):
        return self.id

    def get_max_players(self):
        return self.max_players

    def get_players(self):
        return self.players

    def get_size(self):
        return len(self.players)

    def is_full(self):
        return self.get_size() >= self.max_players

    def remove_player(self, playerID: str):
        if playerID in self.players:
            self.players.remove(playerID)

    def add_player(self, playerID: str):
        if playerID not in self.players:
            self.players.add(playerID)

    def has(self, playerID):
        return playerID in self.players


class PlayerHandler:
    def __init__(self, sio):
        # Maps socket_id to Player object
        self.players = dict()
        self.sio = sio

    def get_player_by_id(self, id) -> Player:
        if not self.player_exists(id):
            raise InvalidPlayer("does not exist")
        return self.players[id]

    def player_exists(self, id):
        return id in self.players

    def create_player(self, id):
        if not self.player_exists(id):
            self.players[id] = Player(id)
        return self.players[id]

    def delete_player(self, id):
        self.players.pop(id)

    def reset_player(self, id):
        self.get_player_by_id(id).reset()

    def player_is_ready(self, id) -> bool:
        return self.get_player_by_id(id).get_ready_state()

    def get_player_room(self, id):
        return self.get_player_by_id(id).get_roomID()

    def assign_room_to_player(self, playerID, roomID):
        self.get_player_by_id(playerID).set_roomID(roomID)


class RoomHandler:
    def __init__(self, sio):
        self.rooms = dict()
        self.valid_rooms = set()
        self.sio = sio

    def create_room(self, num_players=2):
        # Generate ID
        unique_id = Util.generate_unique_code(self.valid_rooms)
        self.rooms[unique_id] = Room(unique_id, num_players)
        return unique_id

    def get_room(self, id) -> Room:
        if not self.is_valid_room(id):
            raise InvalidRoom(f"Room {id} does not exist")
        return self.rooms[id]

    def is_valid_room(self, id):
        return id in self.rooms

    async def assign_player_to_room(self, playerID: str, roomID):
        if self.get_room(roomID).has(playerID):
            return
        self.get_room(roomID).add_player(playerID)
        await self.sio.enter_room(playerID, roomID)
        print(f"assigned player {playerID} to room {roomID}")

    async def remove_player_from_all_rooms(self, player):
        for room in self.rooms:
            await self.remove_player_from_room(player, room)

    async def remove_player_from_room(self, player: str, roomID):
        self.get_room(roomID).remove_player(player)
        await self.sio.leave_room(player, roomID)
        if len(self.get_players(roomID)) == 0:
            self.delete_room(roomID)

    def room_is_full(self, roomID):
        return self.get_room(roomID).is_full()

    def player_is_in_room(self, playerID, roomID):
        return self.get_room(roomID).has(playerID)

    def get_players(self, roomID):
        return self.get_room(roomID).get_players()

    def delete_room(self, roomID):
        self.rooms.pop(roomID)


class SocketServer:
    def __init__(self, host="localhost", port=4000):
        self.sio = socketio.AsyncServer(cors_allowed_origins="*")
        self.app = web.Application()
        self.sio.attach(self.app)
        self.host = host
        self.port = port

        # Register event handlers
        self.sio.on("connect", self.connection)
        self.sio.on("disconnect", self.disconnecting)
        self.sio.on("requestRoom", self.handle_room_request)
        self.sio.on("requestToJoin", self.handle_join_request)
        self.sio.on("playerReady", self.handle_player_ready)
        self.sio.on("leaveRoom", self.leave_room)
        self.sio.on("scoreUpdate", self.handle_score_update)
        self.sio.on("letsPlayAgain", self.handle_play_again)
        self.sio.on("pingServer", self.handle_ping)

        # Data structures to handle connections
        self.room_handler = RoomHandler(self.sio)
        self.player_handler = PlayerHandler(self.sio)
        # TODO: env variables
        self.words_api = WordsAPI("https://andvygrams.andytpngo.org")

    async def connection(self, sid, environ):
        # Create a player
        print(f"Client connected: {sid}")
        self.player_handler.create_player(sid)

    async def disconnecting(self, sid):
        print(f"Client disconnected: {sid}")
        # Let your opponent know
        roomID = self.player_handler.get_player_by_id(sid).get_roomID()
        if roomID:
            await self.sio.emit("opponentLeft", room=roomID, skip_sid=sid)
            self.player_handler.get_player_by_id(sid).set_roomID(None)
        self.player_handler.delete_player(sid)
        await self.room_handler.remove_player_from_all_rooms(sid)

    async def handle_room_request(self, sid):
        print(f"{sid} requested a room")
        roomID = self.room_handler.create_room()
        await self.handle_join_request(sid, roomID)
        await self.sio.emit("requestRoomResponse", roomID, to=sid)

    async def handle_join_request(self, sid, roomID):
        is_invalid = not self.room_handler.is_valid_room(roomID)
        is_full = self.room_handler.room_is_full(roomID)
        if is_invalid or is_full:
            await self.sio.emit("responseRequestToJoin", False, to=sid)
            return
        # Try to join the room
        await self.room_handler.assign_player_to_room(sid, roomID)
        self.player_handler.assign_room_to_player(sid, roomID)
        await self.sio.emit("responseRequestToJoin", True, to=sid)
        # Game is ready to start when the room is full
        if self.room_handler.room_is_full(roomID):
            await self.sio.emit("gameReady", room=roomID)

    async def handle_player_ready(self, sid, roomID):
        print(f"{sid} is trying to ready up")
        self.player_handler.get_player_by_id(sid).set_ready_state(True)
        # Acknowledge ready state back to player
        await self.sio.emit("playerReadyResponse", True, to=sid)
        # Let the other players know you are ready
        await self.sio.emit("opponentReady", room=roomID, skip_sid=sid)
        # Fetch game data if both are ready
        if not self.all_players_ready(roomID):
            return
        # TODO: create new FAST API to get word data
        await self.start_game_in_room(roomID)

    async def leave_room(self, sid, roomID):
        await self.room_handler.remove_player_from_room(sid, roomID)
        self.player_handler.reset_player(sid)
        # Notify the other players in the room
        await self.sio.emit("opponentLeft", room=roomID, skip_sid=sid)

    async def handle_score_update(self, sid, points, words):
        player = self.player_handler.get_player_by_id(sid)
        roomID = player.get_roomID()
        player.set_score(points)
        player.set_words(words)
        # TODO: will have to refactor this bit (probably move everything into a "Game" object later on to support many players)
        my_score = player.get_score()
        # opponent score
        # TODO: GET RID OF THIS, FIX FRONTEND LOGIC TO HANDLE MULTIPLE PLAYERS
        for playerID in self.room_handler.get_players(roomID):
            if playerID == sid:
                continue
            other_player = playerID
            break
        opponent = self.player_handler.get_player_by_id(other_player)
        # Update your score
        scores = {"you": my_score, "opponent": opponent.get_score()}
        words = {"you": player.get_words(), "opponent": opponent.get_words()}
        await self.sio.emit("scoreboardUpdate", [scores, words], to=sid)

        # Update opponent
        scores = {"opponent": my_score, "you": opponent.get_score()}
        words = {"opponent": player.get_words(), "you": opponent.get_words()}
        await self.sio.emit("scoreboardUpdate", [scores, words], to=other_player)

    async def start_game_in_room(self, roomID):
        word, word_data = self.get_game()
        await self.sio.emit("dataReady", [word, word_data], room=roomID)
        for playerID in self.room_handler.get_players(roomID):
            self.player_handler.get_player_by_id(playerID).reset()

    async def handle_play_again(self, sid, roomID):
        self.player_handler.get_player_by_id(sid).set_ready_state(True)
        if not self.all_players_ready(roomID):
            await self.sio.emit("opponentWantsToPlayAgain", room=roomID, skip_sid=sid)
            return
        await self.sio.emit("resetAndGetReady", room=roomID)
        await self.start_game_in_room(roomID)

    # Latency check
    async def handle_ping(self, sid, timestamp):
        if not self.player_handler.player_exists(sid):
            return
        await self.sio.emit("pingFromServer", timestamp, to=sid)

    def all_players_ready(self, roomID):
        ready_count = [
            self.player_handler.player_is_ready(player_id)
            for player_id in self.room_handler.get_room(roomID).get_players()
        ]
        total = len(ready_count)
        ready = ready_count.count(True)
        print(f"{ready}/{total} players are ready")
        return ready == total

    def get_game(self):
        word = self.words_api.get_random_word()
        if word is None:
            raise APIConnectionError("Unable to fetch random word from Words API")
        word_data = self.words_api.get_anagrams_of_word(word)
        if word_data is None:
            raise APIConnectionError(
                "Unable to generate anagrams of word using Words API"
            )
        return [c for c in word], word_data

    def run(self):
        print(f"Server running on http://{self.host}:{self.port}")
        web.run_app(self.app, host=self.host, port=self.port)


if __name__ == "__main__":
    server = SocketServer()
    server.run()
