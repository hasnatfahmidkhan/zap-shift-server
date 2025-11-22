const express = require("express");
const dotenv = require("dotenv");
dotenv.config();
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_KEY);
const { nanoid } = require("nanoid");
const app = express();
const port = process.env.PORT || 3000;

// Generate tracking ID
const generateTrackingId = () => {
  // 1. Date part (YYYYMMDD)
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const dateStr = `${yyyy}${mm}${dd}`;

  // 2. Random 4-digit number
  const randomNumber = Math.floor(1000 + Math.random() * 9000);

  // 3. Random 4-char nanoid
  const suffix = nanoid(4).toUpperCase();

  // 4. Final ID
  return `TRK-${dateStr}-${randomNumber}-${suffix}`;
};

const admin = require("firebase-admin");

const serviceAccount = require("./firebase_service_key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Middleware
app.use(express.json());
app.use(cors());

const verifyFBToken = async (req, res, next) => {
  const authorization = req.headers.authorization;
  if (!authorization) {
    return res.status(401).json({ message: "unauthorized access" });
  }
  const tokenId = authorization.split(" ")[1];
  if (!tokenId) {
    return res.status(401).json({ message: "unauthorized access" });
  }

  const decoded = await admin.auth().verifyIdToken(tokenId);
  req.decoded_email = decoded.email;
  next();
};

const uri = process.env.MONGOURL;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const zapShiftDB = client.db("zapShiftDB");
    const parcelsCollection = zapShiftDB.collection("parcels");
    const paymentCollection = zapShiftDB.collection("payments");
    const userCollection = zapShiftDB.collection("users");
    const riderCollection = zapShiftDB.collection("riders");

    //* User related Apis

    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date().toISOString();
      const email = user.email;

      const isExitsUser = await userCollection.findOne({ email });
      if (isExitsUser) {
        return res.send({ message: "User already exits" });
      }
      const result = await userCollection.insertOne(user);
      res.status(201).json(result);
    });

    //? Rider related Apis
    app.get("/riders", async (req, res) => {
      const query = { status: "pending" };
      const status = req.query?.status;
      if (status) {
        query.status = status;
      }
      const result = await riderCollection.find(query).toArray();
      res.status(200).json(result);
    });

    app.post("/riders", async (req, res) => {
      const rider = req.body;
      rider.createdAt = new Date().toISOString();
      rider.status = "pending";
      const email = rider.email;
      const query = { email };
      const isExitsRider = await riderCollection.findOne(query);
      if (isExitsRider) {
        return res.json({ message: "Rider is exits already!" });
      }
      const result = await riderCollection.insertOne(rider);
      res.status(201).json(result);
    });

    //* parcels api
    // get parcels
    app.get("/parcels", async (req, res) => {
      // sort search limit skip
      const email = req.query.email;
      const query = {};
      if (email) {
        query.senderEmail = email;
      }
      const options = { createdAt: -1 };
      const result = await parcelsCollection
        .find(query)
        .sort(options)
        .toArray();
      res.status(200).json(result);
    });

    // post parcels
    app.post("/parcels", async (req, res) => {
      const newParcel = req.body;
      const result = await parcelsCollection.insertOne(newParcel);
      res.status(201).json(result);
    });

    // delete parcels
    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.deleteOne(query);
      res.status(200).json(result);
    });

    //? PayMent Apis
    app.get("/payment-history", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {};

      if (email) {
        query.customarEmail = email;

        if (email !== req.decoded_email) {
          return res.status(403).json({ message: "forbidden access" });
        }
      }
      const options = { paidAt: -1 };
      const result = await paymentCollection
        .find(query)
        .sort(options)
        .toArray();
      res.send(result);
    });

    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = paymentInfo.amount * 100;
      console.log(paymentInfo);

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            // # Provide the exact Price ID (e.g. price_1234) of the product you want to sell
            price_data: {
              currency: "bdt",
              unit_amount: amount,
              product_data: {
                name: paymentInfo.parcelName,
              },
            },

            quantity: 1,
          },
        ],
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName,
        },
        customer_email: paymentInfo.senderEmail,
        mode: "payment",
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?success=true&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-canceled`,
      });

      res.send({ url: session.url });
    });

    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      // console.log(session);
      const trackingId = generateTrackingId();
      const query = { transactionId: session.payment_intent };
      const isExits = await paymentCollection.findOne(query);
      if (isExits) {
        return res.send({
          message: "payment already exits",
          transactionId: session.payment_intent,
          trackingId: isExits.trackingId,
        });
      }

      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: "paid",
            trackingId: trackingId,
          },
        };
        const result = await parcelsCollection.updateOne(query, update);

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customarEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          paymentStatus: session.payment_status,
          transactionId: session.payment_intent,
          paidAt: new Date().toISOString(),
          trackingId: trackingId,
        };

        if (session.payment_status === "paid") {
          const paymentResult = await paymentCollection.insertOne(payment);
          res.json({
            success: true,
            modifyParcel: result,
            trackingId: trackingId,
            transactionId: session.payment_intent,
            paymentInfo: paymentResult,
          });
        }
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Zap shift server is running!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
