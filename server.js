import { createServer } from "http";
import { Server } from "socket.io";
import axios from "axios"
import dotenv from 'dotenv';

dotenv.config()

const httpServer = createServer()
// require('dotenv').config();
// const mongoose = require('mongoose')
const io = new Server(httpServer, {
  // ...
  cors: {
    origin: "http://localhost:3000"
  }
});

const connectMongo = async () => mongoose.connect(process.env.DB_URL)

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
        socket.leave(socket_dict[socket.id].room) // leave room
    })

    socket.on("checkRoom", (roomID) => {
        console.log("Checking if " + roomID + " is a valid room: " + rooms.has(roomID))
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
        console.log("Socket " + socket.id + " is ready to play in " + roomID);
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
                console.log("Found other socket: " + player)
            }
        }
        if (otherSocket !== null)
        {
            io.to(otherSocket).emit("opponentReady")
            if (room_dict[roomID]["ready"].size == 2)
            {
                // both players ready
                // fetch words and notify
                axios.post('http://localhost:3000/api/words', {'length': 6}).then(
                    res => {
                        let words = res.data.words;
                        const randomNum = Math.floor(Math.random()*words.length);
                        const word = words[randomNum];
                        const shuffled = shuffleArray(Array.from(word));
                        console.log("Anagram: " + shuffled)
                        axios.post('http://localhost:3000/api/anagrams/letters', {"letters": word}).then(
                            res_2 => {
                                console.log("Word data:")
                                console.log(res_2.data.words)
                                // socket emit data
                                io.to(roomID).emit("dataReady", [shuffled, res_2.data.words])
                            }
                        )
                        
                    }
                )
            }
        }
    })

    socket.on("requestToJoin", (roomID) => {
        console.log("Socket " + socket.id + " requesting to join " + roomID + ".")
        if ((rooms.has(roomID) && io.sockets.adapter.rooms.get(roomID) && io.sockets.adapter.rooms.get(roomID).size < 2) || (socket_dict[socket.id]["room"] == roomID))
        {
            if (socket_dict[socket.id]["room"] != roomID)
            {
                socket.join(roomID)
                socket_dict[socket.id]["room"] = roomID
                console.log("Assigned " + socket.id + " to room " + roomID)
                room_dict[roomID]["players"].add(socket.id)
            }
            else
            {
                console.log("Socket " + socket.id + " already in room " + roomID)
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
                console.log("Room " + roomID + " is already full!")
            }
            else
            {
                console.log("Room " + roomID + " doesn't exist!")
            }
            socket.emit("responseRequestToJoin", false)
        }
    })

    socket.on("requestRoom", () => {
        // search current rooms to see if there's anyone in it
        console.log("Socket " + socket.id + " is requesting a room...")
        let freeRoom = null
        // leave existing rooms
        for (const room of rooms)
        {
            const clients = io.sockets.adapter.rooms.get(room)
            console.log(typeof clients)
            if (clients && clients.has(socket.id))
            {
                console.log("socket " + socket.id + " is in room " + room + ". Leaving this room...")
                socket.leave(room)
            }
            if (clients && clients.length == 0)
            {
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

        console.log("Found a room: " + freeRoom)
        console.log("Assigned " + socket.id + " to room " + freeRoom)

        socket.emit('requestRoomResponse', freeRoom)
    })
});


httpServer.listen(4000);