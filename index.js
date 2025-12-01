const express = require("express");
const dotenv = require("dotenv");
dotenv.config();
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_KEY);
const app = express();
const port = process.env.PORT || 5000;

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

  // 3. Random 6-char secure ID using crypto.randomUUID()
  const suffix = crypto
    .randomUUID()
    .replace(/-/g, "")
    .slice(0, 6)
    .toUpperCase();

  // 4. Final ID
  return `TRK-${dateStr}-${randomNumber}-${suffix}`;
};

const admin = require("firebase-admin");

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decoded);

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

// middleware for check user is admin or not
const verifyAdminRole = async (req, res, next) => {
  const email = req.decoded_email;
  const query = { email };
  const user = await userCollection.findOne(query);
  if (!user || user.role !== "admin") {
    return res.status(403).json({ message: "forbidden access" });
  }
  next();
};
// middleware for check user is rider or not
const verifyRiderRole = async (req, res, next) => {
  const email = req.decoded_email;
  const query = { email };
  const user = await userCollection.findOne(query);
  if (!user || user.role !== "rider") {
    return res.status(403).json({ message: "forbidden access" });
  }
  next();
};

// tracking logs func
const trackingLog = async (trackingId, status) => {
  const logInfo = {
    trackingId,
    status,
    details: status.split("-").join(" "),
    createdAt: new Date().toISOString(),
  };
  const result = await trackingCollection.insertOne(logInfo);
  return result;
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
    const trackingCollection = zapShiftDB.collection("trackings");

    //* User related Apis
    app.get("/users", async (req, res) => {
      const { limit = 0, skip = 0, search } = req.query;
      const query = {};
      if (search) {
        query.$or = [
          { displayName: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } },
        ];
      }
      const total = await userCollection.countDocuments(query);
      const users = await userCollection
        .find(query)
        .limit(Number(limit))
        .skip(Number(skip))
        .toArray();
      res.json({ users, total });
    });

    app.get("/users/:id", async (req, res) => {
      const id = req.params.id;
      // const result = await userCollection.find().toArray();
      // res.json(result);
    });

    app.get("/users/:email/role", verifyFBToken, async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const result = await userCollection.findOne(query);
      res.json({ role: result?.role } || "user");
    });

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

    app.patch(
      "/users/:id/role",
      verifyFBToken,
      verifyAdminRole,
      async (req, res) => {
        const id = req.params.id;
        const userInfo = req.body;

        const query = { _id: new ObjectId(id) };
        const updateDoc = { $set: { role: userInfo.role } };
        const result = await userCollection.updateOne(query, updateDoc);
        res.json(result);
      }
    );

    //? Rider related Apis
    app.get("/riders", verifyFBToken, verifyAdminRole, async (req, res) => {
      const query = {};
      const { status, workStatus, district } = req.query;

      if (status) {
        query.status = status;
      }
      if (workStatus) {
        query.workStatus = workStatus;
      }
      if (district) {
        query.riderDistrict = district;
      }
      const result = await riderCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      res.status(200).json(result);
    });

    app.get("/rider/delivery-per-day", async (req, res) => {
      const email = req.query.email;

      const pipeline = [
        { $match: { riderEmail: email } },

        {
          $lookup: {
            from: "trackings",
            localField: "trackingId",
            foreignField: "trackingId",
            as: "tracks",
          },
        },

        { $unwind: "$tracks" },

        { $match: { "tracks.status": "delivered" } },

        // Convert string -> Date
        {
          $addFields: {
            deliveredAt: { $toDate: "$tracks.createdAt" },
          },
        },

        // Group by formatted date
        {
          $group: {
            _id: {
              date: {
                $dateToString: { format: "%Y-%m-%d", date: "$deliveredAt" },
              },
            },
            deliveredCount: { $sum: 1 },
          },
        },
        {
          $project: {
            date: "$_id.date",
            deliveredCount: 1,
            _id: 0,
          },
        },

        // { $sort: { "_id.date": 1 } },
      ];

      const result = await parcelsCollection.aggregate(pipeline).toArray();
      res.json(result);
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

    app.patch(
      "/riders/:id",
      verifyFBToken,
      verifyAdminRole,
      async (req, res) => {
        const id = req.params.id;
        const status = req.body.status;
        const query = { _id: new ObjectId(id) };
        const update = { $set: { status: status, workStatus: "available" } };
        const result = await riderCollection.updateOne(query, update);
        if (status === "approved") {
          const email = req.body.email;
          const userQuery = { email };
          const updateRole = { $set: { role: "rider" } };
          await userCollection.updateOne(userQuery, updateRole);
        }
        res.json(result);
      }
    );

    app.delete("/riders/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await riderCollection.deleteOne(query);
      res.json(result);
    });

    //* parcels api
    // get parcels
    app.get("/parcels", async (req, res) => {
      // sort search limit skip
      const { email, deliveryStatus } = req.query;
      const query = {};
      if (email) {
        query.senderEmail = email;
      }
      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }
      const options = { createdAt: -1 };
      const result = await parcelsCollection
        .find(query)
        .sort(options)
        .toArray();
      res.status(200).json(result);
    });

    app.get(
      "/parcels/rider",
      verifyFBToken,
      verifyRiderRole,
      async (req, res) => {
        const { riderEmail, deliveryStatus } = req.query;

        const query = {};
        if (riderEmail) {
          query.riderEmail = riderEmail;
        }
        if (deliveryStatus !== "delivered") {
          query.deliveryStatus = {
            $nin: ["delivered"],
          };
        } else {
          query.deliveryStatus = deliveryStatus;
        }
        const result = await parcelsCollection.find(query).toArray();

        res.json(result);
      }
    );

    app.get(
      "/parcels/delivery-stats",
      verifyFBToken,
      verifyAdminRole,
      async (req, res) => {
        const pipeline = [
          {
            $group: {
              _id: "$deliveryStatus",
              count: { $sum: 1 },
            },
          },
          {
            $project: {
              status: "$_id",
              count: 1,
              _id: 0,
            },
          },
        ];
        const result = await parcelsCollection.aggregate(pipeline).toArray();
        res.json(result);
      }
    );

    // post parcels
    app.post("/parcels", async (req, res) => {
      const newParcel = req.body;
      const trackingId = generateTrackingId();
      newParcel.trackingId = trackingId;
      const result = await parcelsCollection.insertOne(newParcel);
      trackingLog(trackingId, "parcel-created");
      res.status(201).json(result);
    });

    app.patch("/parcels/:id/assign", async (req, res) => {
      const { trackingId, riderId, riderName, riderEmail } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          deliveryStatus: "rider-assigned",
          riderId,
          riderName,
          riderEmail,
        },
      };
      const result = await parcelsCollection.updateOne(query, updateDoc);
      trackingLog(trackingId, "rider-assigned");
      // update rider info
      const riderQuery = { _id: new ObjectId(riderId) };
      const riderUpdatedDoc = { $set: { workStatus: "in-delivery" } };
      const riderResult = await riderCollection.updateOne(
        riderQuery,
        riderUpdatedDoc
      );
      res.json({ parcelInfo: result, riderInfo: riderResult });
    });

    app.patch(
      "/parcels/:id/deliveryStatus",
      verifyFBToken,
      verifyRiderRole,
      async (req, res) => {
        const { deliveryStatus, email, trackingId } = req.body;
        const query = { _id: new ObjectId(req.params.id) };
        const updateDoc = { $set: { deliveryStatus } };
        if (
          deliveryStatus === "delivered" ||
          deliveryStatus === "parcel-paid"
        ) {
          await riderCollection.updateOne(
            { email },
            { $set: { workStatus: "available" } }
          );
        }
        const result = await parcelsCollection.updateOne(query, updateDoc);
        trackingLog(trackingId, deliveryStatus);
        res.json(result);
      }
    );

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
      const parcelInfo = req.body;
      const amount = parcelInfo.amount * 100;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            // # Provide the exact Price ID (e.g. price_1234) of the product you want to sell
            price_data: {
              currency: "bdt",
              unit_amount: amount,
              product_data: {
                name: parcelInfo.parcelName,
              },
            },

            quantity: 1,
          },
        ],
        metadata: {
          parcelId: parcelInfo.parcelId,
          parcelName: parcelInfo.parcelName,
          trackingId: parcelInfo.trackingId,
        },
        customer_email: parcelInfo.senderEmail,
        mode: "payment",
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?success=true&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/my-parcels`,
      });

      res.send({ url: session.url });
    });

    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      const query = { transactionId: session.payment_intent };
      const isExits = await paymentCollection.findOne(query);
      if (isExits) {
        return res.send({
          message: "payment already exits",
          transactionId: session.payment_intent,
          trackingId: isExits.trackingId,
          amount: session.amount_total / 100,
          paidAt: new Date().toISOString(),
        });
      }

      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: "paid",
            trackingId: session.metadata.trackingId,
            deliveryStatus: "parcel-paid",
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
          trackingId: session.metadata.trackingId,
        };

        const paymentResult = await paymentCollection.insertOne(payment);
        trackingLog(session.metadata.trackingId, "parcel-paid");
        return res.json({
          success: true,
          modifyParcel: result,
          trackingId: session.metadata.trackingId,
          transactionId: session.payment_intent,
          amount: session.amount_total / 100,
          paymentInfo: paymentResult,
          paidAt: new Date().toISOString(),
        });
      }

      return res.json({ success: false });
    });

    // tracking api
    app.get("/trackings/:id", async (req, res) => {
      const id = req.params.id;

      const result = await trackingCollection
        .find({ trackingId: id })
        .toArray();
      res.json(result);
    });

    // await client.db("admin").command({ ping: 1 });
    // console.log(
    //   "Pinged your deployment. You successfully connected to MongoDB!"
    // );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Zap shift server is running!");
});

app.listen(port, () => {
  console.log(`Zap shift app listening on port ${port}`);
});
