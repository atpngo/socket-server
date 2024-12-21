import { createServer } from "http";
import { Server } from "socket.io";
import axios from "axios"
import dotenv from 'dotenv';

dotenv.config()

const httpServer = createServer()

let DEBUG = true;
// const mongoose = require('mongoose')
const io = new Server(httpServer, {
  // ...
  cors: {
    // origin: "http://localhost:3000"
    // origin: process.env.CLIENT_URL
    // origin: "http://localhost:3000"
    origin: ["http://192.168.2.2:3000", "http://raspberrypi.local:3000", "https://andvygrams.andytpngo.org"]
  }
}); 

// Set to keep track of all the rooms
let rooms = new Set()
// Dictionary that maps a socket to it's room number
let socket_dict = new Object()
// Dictionary that maps a room number to each player's status
let room_dict = new Object();

// helper functions to generate codes
function generateCode()
{
    let code;
    do {
        code = getRandomCode();
    } while (rooms.has(code))
    return code
}

function getRandomCode()
{
    return Array.from({length: 4}, () => String.fromCharCode(Math.floor(Math.random() * 26) + 65)).join('')
}

function shuffleArray(array) {
    let a = [...array];
    return a.sort(() => Math.random() - 0.5);
}

io.on("connection", (socket) => {
    console.log("A socket connected " + socket.id)
    socket_dict[socket.id] = new Object()

    socket.on("disconnecting", (reason) => {
        console.log("Socket left: " + socket.id )
        const roomID = socket_dict[socket.id].room
        if (roomID !== undefined)
        {
            socket.leave(roomID) // leave room
            if (DEBUG) console.log("Socket " + socket.id + " leaving room " + roomID);
            // notify other player?
            let other = null;
            for (const player of room_dict[roomID]["players"])
            {
                if (player !== socket.id)
                {
                    other = player;
                }
            }
            socket.to(other).emit("opponentLeft")
            room_dict[roomID]["players"].delete(socket.id) // leave room_dict.players
            room_dict[roomID]["ready"].delete(socket.id) // leave room_dict.ready
        }
    })

    socket.on("letsPlayAgain", (roomID) => {
        // READY UP
        room_dict[roomID]["ready"].add(socket.id)
        // Broadcast to the other socket you want to play again
        let other = null;
        for (const player of room_dict[roomID]["players"])
        {
            if (player !== socket.id)
            {
                other = player;
            }
        }
        if (room_dict[roomID]["ready"].size === 2) {
            // other player is already ready
            // Reset the rooms, LETS PLAY!!!
            console.log('Both opponents are ready to play again')
            // (1) Emit to all sockets in the room to reset their state
            io.to(roomID).emit("resetAndGetReady")
            // (2) Fetch new game data
            axios.post(process.env.API_URL + '/api/words', {'length': 6}).then(
                res => {
                    let words = res.data.words;
                    const randomNum = Math.floor(Math.random()*words.length);
                    const word = words[randomNum];
                    const shuffled = shuffleArray(Array.from(word));
                    if (DEBUG) console.log("Anagram: " + shuffled)
                    axios.post(process.env.API_URL + '/api/anagrams/letters', {"letters": word}).then(
                        res_2 => {
                            if (DEBUG) console.log("Word data:")
                            if (DEBUG) console.log(res_2.data.words)
                            // socket emit data
                            io.to(roomID).emit("dataReady", [shuffled, res_2.data.words])
                            // reset ready room
                            room_dict[roomID]["ready"] = new Set();
                        }
                    )
                    
                }
            )
            // (3) Sent new game data to sockets :)

        } else {
            socket.to(other).emit("opponentWantsToPlayAgain")
            // make it so that a lil symbol appearas on their screen
        }
    });

    socket.on("leaveRoom", (roomID) => {
        if (DEBUG) console.log("Socket " + socket.id + " room "+ roomID)
        socket.leave(roomID) // leave room
        // notify other player?
        let other = null;
        for (const player of room_dict[roomID]["players"])
        {
            if (player !== socket.id)
            {
                other = player;
            }
        }
        socket.to(other).emit("opponentLeft")
        room_dict[roomID]["players"].delete(socket.id) // leave room_dict.players
        room_dict[roomID]["ready"].delete(socket.id) // leave room_dict.ready
    })

    socket.on("checkRoom", (roomID) => {
        if (DEBUG) console.log("Checking if " + roomID + " is a valid room: " + rooms.has(roomID))
        socket.emit("checkRoomResult", rooms.has(roomID))
    })

    socket.on("scoreUpdate", (points, words) => {
        let roomID = socket_dict[socket.id]["room"]
        room_dict[roomID]["score"][socket.id] = points
        room_dict[roomID]["words"][socket.id] = words


        // broadcast
        let other = null;
        for (const player of room_dict[roomID]["players"])
        {
            if (player !== socket.id)
            {
                other = player
            }
        }
        // tell other player the score
        io.to(other).emit("scoreboardUpdate", [{"opponent": points, "you": room_dict[roomID]["score"][other]}, {"opponent": words, "you": room_dict[roomID]["words"][other]}])
        socket.emit("scoreboardUpdate", [{"you": points, "opponent": room_dict[roomID]["score"][other]}, {"you": words, "opponent": room_dict[roomID]["words"][other]}])
    })

    socket.on("playerReady", async (roomID) => {
        if (DEBUG) console.log("Socket " + socket.id + " is ready to play in " + roomID);
        // return two things: YOUR STATUS, OPPONENT STATUS
        // send message to self that server acknowledges you are ready
        room_dict[roomID]["ready"].add(socket.id)
        room_dict[roomID]["score"][socket.id] = 0
        room_dict[roomID]["words"][socket.id] = []
        socket.emit("playerReadyResponse", true)


        let otherSocket = null
        for (const player of room_dict[roomID]["players"])
        {
            if (player != socket.id)
            {
                otherSocket = player
                if (DEBUG) console.log("Found other socket: " + player)
            }
        }
        if (otherSocket !== null)
        {
            io.to(otherSocket).emit("opponentReady")
            if (room_dict[roomID]["ready"].size == 2)
            {
                // both players ready
                // fetch words and notify
                axios.post(process.env.API_URL + '/api/words', {'length': 6}).then(
                    res => {
                        let words = res.data.words;
                        const randomNum = Math.floor(Math.random()*words.length);
                        const word = words[randomNum];
                        const shuffled = shuffleArray(Array.from(word));
                        if (DEBUG) console.log("Anagram: " + shuffled)
                        axios.post(process.env.API_URL + '/api/anagrams/letters', {"letters": word}).then(
                            res_2 => {
                                if (DEBUG) console.log("Word data:")
                                if (DEBUG) console.log(res_2.data.words)
                                // socket emit data
                                io.to(roomID).emit("dataReady", [shuffled, res_2.data.words])
                                // reset ready room
                                room_dict[roomID]["ready"] = new Set();
                            }
                        )
                        
                    }
                )
            }
        }
    })

    socket.on("requestToJoin", (roomID) => {
        if (DEBUG) console.log("Socket " + socket.id + " requesting to join " + roomID + ".")
        if ((rooms.has(roomID) && io.sockets.adapter.rooms.get(roomID) && io.sockets.adapter.rooms.get(roomID).size < 2) || (socket_dict[socket.id]["room"] == roomID))
        {
            if (socket_dict[socket.id]["room"] != roomID)
            {
                socket.join(roomID)
                socket_dict[socket.id]["room"] = roomID
                if (DEBUG) console.log("Assigned " + socket.id + " to room " + roomID)
                room_dict[roomID]["players"].add(socket.id)
            }
            else
            {
                if (DEBUG) console.log("Socket " + socket.id + " already in room " + roomID)
            }
            
            socket.emit("responseRequestToJoin", true)
            if (io.sockets.adapter.rooms.get(roomID).size == 2)
            {
                io.to(roomID).emit("gameReady")

            }
        }
        else
        {
            if (rooms.has(roomID) && io.sockets.adapter.rooms.get(roomID) && io.sockets.adapter.rooms.get(roomID).size == 2)
            {
                if (DEBUG) console.log("Room " + roomID + " is already full!")
            }
            else
            {
                if (DEBUG) console.log("Room " + roomID + " doesn't exist!")
            }
            socket.emit("responseRequestToJoin", false)
        }
    })

    socket.on("requestRoom", () => {
        // search current rooms to see if there's anyone in it
        if (DEBUG) console.log("Socket " + socket.id + " is requesting a room...")
        let freeRoom = null
        // leave existing rooms
        for (const room of rooms)
        {
            const clients = io.sockets.adapter.rooms.get(room)
            if (clients && clients.has(socket.id))
            {
                if (DEBUG) console.log("socket " + socket.id + " is in room " + room + ". Leaving this room...")
                socket.leave(room)
            }
            if (clients && clients.length == 0)
            {
                if (DEBUG) console.log("found an existing room!")
                freeRoom = room;
                break
            }
        }
        if (freeRoom === null)
        {
            // generate code/room
            freeRoom = generateCode();
            // add to rooms
            rooms.add(freeRoom);
            room_dict[freeRoom] = new Object();
            room_dict[freeRoom]["players"] = new Set()
            room_dict[freeRoom]["ready"] = new Set();
            room_dict[freeRoom]["score"] = new Object()
            room_dict[freeRoom]["words"] = new Object()
            
        }
        socket.join(freeRoom)
        socket_dict[socket.id]["room"] = freeRoom
        room_dict[freeRoom]["players"].add(socket.id)

        if (DEBUG) console.log("Found a room: " + freeRoom)
        if (DEBUG) console.log("Assigned " + socket.id + " to room " + freeRoom)

        socket.emit('requestRoomResponse', freeRoom)
    })
});



console.log("Starting server on port: " + (process.env.PORT || 4000))
httpServer.listen(process.env.PORT || 4000);