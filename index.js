const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");

require("dotenv").config();

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const port = process.env.PORT || 5000;

const app = express();

app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.tiabmdh.mongodb.net/?retryWrites=true&w=majority`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

function verifyJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send("unauthorized access");
  }
  const token = authHeader.split(" ")[1];
  jwt.verify(token, process.env.ACCESS_TOKEN, function (err, decoded) {
    if (err) {
      return res.status(403).send({ message: "forbidden access" });
    }
    req.decoded = decoded;
    next();
  });
}

async function run() {
  try {
    const appointmentOptionsCollection = client
      .db("doctorsPortal")
      .collection("appointmentOptions");

    const bookingsCollection = client
      .db("doctorsPortal")
      .collection("bookings");
    const usersCollection = client.db("doctorsPortal").collection("users");
    const doctorsCollection = client.db("doctorsPortal").collection("doctors");
    const paymentsCollection = client
      .db("doctorsPortal")
      .collection("payments");

    //verify admin must be after verifyJWT
    const verifyAdmin = async (req, res, next) => {
      const decodedEmail = req.decoded.email;
      const query = { email: decodedEmail };
      const user = await usersCollection.findOne(query);

      if (user?.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    // V1 = appoinment dynamically update using normal query

    // app.get("/appointmentOptions", async (req, res) => {
    //   const date = req.query.date;
    //   const query = {};
    //   const options = await appointmentOptionsCollection.find(query).toArray();

    //   //get the booking of the provided date
    //   const bookingQuery = { appointmentDate: date };
    //   const alreadyBooked = await bookingsCollection
    //     .find(bookingQuery)
    //     .toArray();

    //   options.forEach((option) => {
    //     const optionBooked = alreadyBooked.filter(
    //       (book) => book.treatment === option.name
    //     );
    //     const bookedSlots = optionBooked.map((book) => book.slot);
    //     const remainingSlots = option.slots.filter(
    //       (slot) => !bookedSlots.includes(slot)
    //     );
    //     option.slots = remainingSlots;
    //   });
    //   res.send(options);
    // });

    // V2 = Appointment dynamically update using pipline

    app.get("/v2/appointmentOptions", async (req, res) => {
      const date = req.query.date;

      //use Aggregate to query multiple collection and then merge data

      const options = await appointmentOptionsCollection
        .aggregate([
          {
            $lookup: {
              from: "bookings",
              localField: "name",
              foreignField: "treatment",
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $eq: ["$appointmentDate", date],
                    },
                  },
                },
              ],
              as: "booked",
            },
          },
          {
            $project: {
              name: 1,
              price: 1,
              slots: 1,
              booked: {
                $map: {
                  input: "$booked",
                  as: "book",
                  in: "$$book.slot",
                },
              },
            },
          },
          {
            $project: {
              name: 1,
              price: 1,
              slots: {
                $setDifference: ["$slots", "$booked"],
              },
            },
          },
        ])
        .toArray();
      res.send(options);
    });

    //Appointment specialty api
    app.get("/appointmentSpecialty", async (req, res) => {
      const query = {};
      const result = await appointmentOptionsCollection
        .find(query)
        .project({ name: 1 })
        .toArray();
      res.send(result);
    });

    app.get("/bookings", verifyJWT, async (req, res) => {
      const email = req.query.email;
      const decodedEmail = req.decoded.email;
      if (email != decodedEmail) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const query = { email: email };
      const bookings = await bookingsCollection.find(query).toArray();
      res.send(bookings);
    });

    app.get("/bookings/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await bookingsCollection.findOne(query);
      res.send(result);
    });

    app.post("/bookings", async (req, res) => {
      const booking = req.body;
      const query = {
        appointmentDate: booking.appointmentDate,
        email: booking.email,
        treatment: booking.treatment,
      };

      const countBooked = await bookingsCollection.find(query).toArray();

      if (countBooked.length) {
        const message = `You already have a booking on ${booking.appointmentDate}`;
        return res.send({ acknowledged: false, message });
      }

      const result = await bookingsCollection.insertOne(booking);
      res.send(result);
    });

    // stripe payment api

    app.post("/create-payment-intent", async (req, res) => {
      const booking = req.body;
      const price = booking.price;
      const amount = price * 100;

      const paymentIntent = await stripe.paymentIntents.create({
        currency: "usd",
        amount: amount,
        payment_method_types: ["card"],
      });
      res.send({ clientSecret: paymentIntent.client_secret });
    });

    app.post("/payments", async (req, res) => {
      const payment = req.body;
      const result = await paymentsCollection.insertOne(payment);
      const id = payment.bookingId;
      const filter = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          paid: true,
          transactionId: payment.transactionId,
        },
      };
      const updatedResult = await bookingsCollection.updateOne(
        filter,
        updatedDoc
      );

      res.send(result);
    });

    app.get("/jwt", async (req, res) => {
      const email = req.query.email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      if (user) {
        const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, {
          expiresIn: "1d",
        });
        return res.send({ accessToken: token });
      }
      res.status(403).send({ accessToken: "" });
    });

    app.get("/users", async (req, res) => {
      const query = {};
      const users = await usersCollection.find(query).toArray();
      res.send(users);
    });

    // perticular admin check

    app.get("/users/admin/:email", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ isAdmin: user?.role === "admin" });
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.put("/users/admin/:id", verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const options = { upsert: true };
      const updatedDoc = {
        $set: {
          role: "admin",
        },
      };
      const result = await usersCollection.updateOne(
        filter,
        updatedDoc,
        options
      );
      res.send(result);
    });

    // temporary add price update appointment.
    // app.get("/addPrice", async (req, res) => {
    //   const filter = {};
    //   const options = { upsert: true };
    //   const updatedDoc = {
    //     $set: {
    //       price: 99,
    //     },
    //   };
    //   const result = await appointmentOptionsCollection.updateMany(
    //     filter,
    //     updatedDoc,
    //     options
    //   );
    //   res.send(result);
    // });

    // doctors managing api
    app.get("/doctors", verifyJWT, verifyAdmin, async (req, res) => {
      const query = {};
      const result = await doctorsCollection.find(query).toArray();
      res.send(result);
    });

    // doctor delete api
    app.post("/doctors", verifyJWT, verifyAdmin, async (req, res) => {
      const doctor = req.body;
      const result = await doctorsCollection.insertOne(doctor);
      res.send(result);
    });

    app.delete("/doctors/:id", verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const result = await doctorsCollection.deleteOne(filter);
      res.send(result);
    });
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", async (req, res) => {
  res.send("doctors server running");
});

app.listen(port, () => console.log(`doctors portal running on ${port}`));
