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
    app.get("/riders", async (req, res) => {
      const { limit = 0, skip = 0, search = "" } = req.query;
      // console.log(limit, skip, search);
      const query = {};
      const { status, workStatus, district } = req.query;

      if (status) {
        query.status = status;
      }

      if (search) {
        query.$or = [
          { name: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } },
        ];
      }

      if (workStatus) {
        query.workStatus = workStatus;
      }
      if (district) {
        query.riderDistrict = district;
      }
      const result = await riderCollection
        .find(query)
        .limit(Number(limit))
        .skip(Number(skip))
        .sort({ createdAt: -1 })
        .toArray();
      const count = await riderCollection.countDocuments();

      res.status(200).json({ result, count });
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

      // Create notification for admin
      await createNotification({
        type: "rider-application",
        title: "New Rider Application",
        message: `${rider.name} applied to become a rider`,
        forRole: "admin",
        relatedId: result.insertedId.toString(),
        metadata: {
          riderName: rider.name,
          riderEmail: rider.email,
          riderPhone: rider.phone,
          riderDistrict: rider.riderDistrict,
        },
      });

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
      newParcel.createdAt = new Date().toISOString();

      const result = await parcelsCollection.insertOne(newParcel);
      trackingLog(trackingId, "parcel-created");

      // Create notification for admin
      await createNotification({
        type: "new-order",
        title: "New Parcel Booked",
        message: `${newParcel.senderName} booked a new parcel to ${newParcel.receiverDistrict}`,
        forRole: "admin",
        relatedId: result.insertedId.toString(),
        trackingId: trackingId,
        metadata: {
          senderName: newParcel.senderName,
          senderEmail: newParcel.senderEmail,
          parcelName: newParcel.parcelName,
        },
      });

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

    // update delivery status
    // app.patch(
    //   "/parcels/:id/deliveryStatus",
    //   verifyFBToken,
    //   verifyRiderRole,
    //   async (req, res) => {
    //     const { deliveryStatus, email, trackingId } = req.body;
    //     const query = { _id: new ObjectId(req.params.id) };
    //     const updateDoc = { $set: { deliveryStatus } };
    //     if (
    //       deliveryStatus === "delivered" ||
    //       deliveryStatus === "parcel-paid"
    //     ) {
    //       await riderCollection.updateOne(
    //         { email },
    //         { $set: { workStatus: "available" } }
    //       );
    //     }
    //     const result = await parcelsCollection.updateOne(query, updateDoc);
    //     trackingLog(trackingId, deliveryStatus);
    //     res.json(result);
    //   }
    // );

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

        // Create notification for admin
        await createNotification({
          type: "payment-received",
          title: "Payment Received",
          message: `Payment of ৳${session.amount_total / 100} received for ${
            session.metadata.parcelName
          }`,
          forRole: "admin",
          relatedId: session.metadata.parcelId,
          trackingId: session.metadata.trackingId,
          metadata: {
            amount: session.amount_total / 100,
            customerEmail: session.customer_email,
            parcelName: session.metadata.parcelName,
          },
        });

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

    // api for admin analitycs
    // Add these routes inside your run() function

    //? Admin Dashboard Stats API
    app.get(
      "/admin/dashboard-stats",
      verifyFBToken,
      verifyAdminRole,
      async (req, res) => {
        try {
          // Total parcels
          const totalParcels = await parcelsCollection.countDocuments();

          // Total delivered
          const totalDelivered = await parcelsCollection.countDocuments({
            deliveryStatus: "delivered",
          });

          // Total users
          const totalUsers = await userCollection.countDocuments();

          // Total riders
          const totalRiders = await riderCollection.countDocuments({
            status: "approved",
          });

          // Total revenue from payments
          const revenueResult = await paymentCollection
            .aggregate([
              {
                $group: {
                  _id: null,
                  totalRevenue: { $sum: "$amount" },
                },
              },
            ])
            .toArray();

          const totalRevenue = revenueResult[0]?.totalRevenue || 0;

          // Average delivery time (you can customize this based on your tracking data)
          const avgDeliveryPipeline = [
            {
              $match: {
                deliveryStatus: "delivered",
              },
            },
            {
              $lookup: {
                from: "trackings",
                localField: "trackingId",
                foreignField: "trackingId",
                as: "tracks",
              },
            },
            {
              $addFields: {
                createdTrack: {
                  $filter: {
                    input: "$tracks",
                    as: "t",
                    cond: { $eq: ["$$t.status", "parcel-created"] },
                  },
                },
                deliveredTrack: {
                  $filter: {
                    input: "$tracks",
                    as: "t",
                    cond: { $eq: ["$$t.status", "delivered"] },
                  },
                },
              },
            },
            {
              $addFields: {
                createdAt: { $arrayElemAt: ["$createdTrack.createdAt", 0] },
                deliveredAt: { $arrayElemAt: ["$deliveredTrack.createdAt", 0] },
              },
            },
            {
              $match: {
                createdAt: { $exists: true },
                deliveredAt: { $exists: true },
              },
            },
            {
              $addFields: {
                deliveryTimeMs: {
                  $subtract: [
                    { $toDate: "$deliveredAt" },
                    { $toDate: "$createdAt" },
                  ],
                },
              },
            },
            {
              $group: {
                _id: null,
                avgDeliveryTimeMs: { $avg: "$deliveryTimeMs" },
              },
            },
          ];

          const avgResult = await parcelsCollection
            .aggregate(avgDeliveryPipeline)
            .toArray();

          // Convert ms to minutes
          const avgDeliveryTime = avgResult[0]?.avgDeliveryTimeMs
            ? Math.round(avgResult[0].avgDeliveryTimeMs / (1000 * 60))
            : 28; // Default fallback

          // Pending parcels
          const pendingParcels = await parcelsCollection.countDocuments({
            deliveryStatus: "pending",
          });

          // In-transit parcels
          const inTransitParcels = await parcelsCollection.countDocuments({
            deliveryStatus: {
              $in: ["rider-assigned", "picked-up", "in-transit"],
            },
          });

          res.json({
            totalParcels,
            totalDelivered,
            totalUsers,
            totalRiders,
            totalRevenue,
            avgDeliveryTime,
            pendingParcels,
            inTransitParcels,
            csatScore: 4.8, // You can implement a rating system later
          });
        } catch (error) {
          console.error("Dashboard stats error:", error);
          res.status(500).json({ message: "Error fetching dashboard stats" });
        }
      }
    );

    //? Revenue Stats API (Last 7 days)
    app.get(
      "/admin/revenue-stats",
      verifyFBToken,
      verifyAdminRole,
      async (req, res) => {
        try {
          const days = parseInt(req.query.days) || 7;

          // Calculate date range
          const endDate = new Date();
          const startDate = new Date();
          startDate.setDate(startDate.getDate() - days);

          const pipeline = [
            {
              $match: {
                paidAt: {
                  $gte: startDate.toISOString(),
                  $lte: endDate.toISOString(),
                },
              },
            },
            {
              $addFields: {
                paidDate: { $toDate: "$paidAt" },
              },
            },
            {
              $group: {
                _id: {
                  $dateToString: { format: "%Y-%m-%d", date: "$paidDate" },
                },
                revenue: { $sum: "$amount" },
                volume: { $sum: 1 },
              },
            },
            {
              $project: {
                date: "$_id",
                revenue: 1,
                volume: 1,
                _id: 0,
              },
            },
            {
              $sort: { date: 1 },
            },
          ];

          const result = await paymentCollection.aggregate(pipeline).toArray();

          // Fill in missing dates with zero values
          const filledData = [];
          for (let i = days - 1; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().split("T")[0];
            const dayName = date.toLocaleDateString("en-US", {
              weekday: "short",
            });

            const existing = result.find((r) => r.date === dateStr);
            filledData.push({
              date: dayName,
              fullDate: dateStr,
              revenue: existing?.revenue || 0,
              volume: existing?.volume || 0,
            });
          }

          res.json(filledData);
        } catch (error) {
          console.error("Revenue stats error:", error);
          res.status(500).json({ message: "Error fetching revenue stats" });
        }
      }
    );

    //? Recent Parcels API
    app.get(
      "/parcels/recent",
      verifyFBToken,
      verifyAdminRole,
      async (req, res) => {
        try {
          const limit = parseInt(req.query.limit) || 5;

          const result = await parcelsCollection
            .find({})
            .sort({ createdAt: -1 })
            .limit(limit)
            .toArray();

          res.json(result);
        } catch (error) {
          console.error("Recent parcels error:", error);
          res.status(500).json({ message: "Error fetching recent parcels" });
        }
      }
    );

    //? Top Performing Riders API
    app.get(
      "/admin/top-riders",
      verifyFBToken,
      verifyAdminRole,
      async (req, res) => {
        try {
          const limit = parseInt(req.query.limit) || 5;

          const pipeline = [
            {
              $match: {
                deliveryStatus: "delivered",
                riderEmail: { $exists: true },
              },
            },
            {
              $group: {
                _id: "$riderEmail",
                riderName: { $first: "$riderName" },
                deliveryCount: { $sum: 1 },
              },
            },
            {
              $sort: { deliveryCount: -1 },
            },
            {
              $limit: limit,
            },
            {
              $project: {
                email: "$_id",
                name: "$riderName",
                deliveries: "$deliveryCount",
                _id: 0,
              },
            },
          ];

          const result = await parcelsCollection.aggregate(pipeline).toArray();
          res.json(result);
        } catch (error) {
          console.error("Top riders error:", error);
          res.status(500).json({ message: "Error fetching top riders" });
        }
      }
    );

    //? Monthly Stats Comparison API
    app.get(
      "/admin/monthly-comparison",
      verifyFBToken,
      verifyAdminRole,
      async (req, res) => {
        try {
          const now = new Date();
          const currentMonth = now.getMonth();
          const currentYear = now.getFullYear();

          // Current month start/end
          const currentMonthStart = new Date(currentYear, currentMonth, 1);
          const currentMonthEnd = new Date(currentYear, currentMonth + 1, 0);

          // Previous month start/end
          const prevMonthStart = new Date(currentYear, currentMonth - 1, 1);
          const prevMonthEnd = new Date(currentYear, currentMonth, 0);

          // Current month stats
          const currentMonthParcels = await parcelsCollection.countDocuments({
            createdAt: {
              $gte: currentMonthStart.toISOString(),
              $lte: currentMonthEnd.toISOString(),
            },
          });

          const currentMonthDelivered = await parcelsCollection.countDocuments({
            deliveryStatus: "delivered",
            createdAt: {
              $gte: currentMonthStart.toISOString(),
              $lte: currentMonthEnd.toISOString(),
            },
          });

          // Previous month stats
          const prevMonthParcels = await parcelsCollection.countDocuments({
            createdAt: {
              $gte: prevMonthStart.toISOString(),
              $lte: prevMonthEnd.toISOString(),
            },
          });

          const prevMonthDelivered = await parcelsCollection.countDocuments({
            deliveryStatus: "delivered",
            createdAt: {
              $gte: prevMonthStart.toISOString(),
              $lte: prevMonthEnd.toISOString(),
            },
          });

          // Calculate percentage changes
          const parcelsChange = prevMonthParcels
            ? (
                ((currentMonthParcels - prevMonthParcels) / prevMonthParcels) *
                100
              ).toFixed(1)
            : 0;

          const deliveredChange = prevMonthDelivered
            ? (
                ((currentMonthDelivered - prevMonthDelivered) /
                  prevMonthDelivered) *
                100
              ).toFixed(1)
            : 0;

          res.json({
            currentMonth: {
              parcels: currentMonthParcels,
              delivered: currentMonthDelivered,
            },
            previousMonth: {
              parcels: prevMonthParcels,
              delivered: prevMonthDelivered,
            },
            changes: {
              parcels: parcelsChange,
              delivered: deliveredChange,
            },
          });
        } catch (error) {
          console.error("Monthly comparison error:", error);
          res
            .status(500)
            .json({ message: "Error fetching monthly comparison" });
        }
      }
    );

    // api for dynamic notification
    // Add this inside your run() function

    //? Notifications Collection & APIs
    const notificationCollection = zapShiftDB.collection("notifications");

    // Create notification helper function
    const createNotification = async (data) => {
      const notification = {
        ...data,
        isRead: false,
        createdAt: new Date().toISOString(),
      };
      const result = await notificationCollection.insertOne(notification);
      return result;
    };

    // Get notifications for admin
    app.get(
      "/notifications",
      verifyFBToken,
      verifyAdminRole,
      async (req, res) => {
        try {
          const { limit = 10, unreadOnly = false } = req.query;

          const query = { forRole: "admin" };
          if (unreadOnly === "true") {
            query.isRead = false;
          }

          const notifications = await notificationCollection
            .find(query)
            .sort({ createdAt: -1 })
            .limit(Number(limit))
            .toArray();

          const unreadCount = await notificationCollection.countDocuments({
            forRole: "admin",
            isRead: false,
          });

          res.json({ notifications, unreadCount });
        } catch (error) {
          console.error("Notifications error:", error);
          res.status(500).json({ message: "Error fetching notifications" });
        }
      }
    );

    // Mark notification as read
    app.patch("/notifications/:id/read", verifyFBToken, async (req, res) => {
      try {
        const id = req.params.id;
        const result = await notificationCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { isRead: true, readAt: new Date().toISOString() } }
        );
        res.json(result);
      } catch (error) {
        console.error("Mark read error:", error);
        res.status(500).json({ message: "Error marking notification as read" });
      }
    });

    // Mark all notifications as read
    app.patch(
      "/notifications/read-all",
      verifyFBToken,
      verifyAdminRole,
      async (req, res) => {
        try {
          const result = await notificationCollection.updateMany(
            { forRole: "admin", isRead: false },
            { $set: { isRead: true, readAt: new Date().toISOString() } }
          );
          res.json(result);
        } catch (error) {
          console.error("Mark all read error:", error);
          res.status(500).json({ message: "Error marking all as read" });
        }
      }
    );

    // Delete notification
    app.delete("/notifications/:id", verifyFBToken, async (req, res) => {
      try {
        const id = req.params.id;
        const result = await notificationCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.json(result);
      } catch (error) {
        console.error("Delete notification error:", error);
        res.status(500).json({ message: "Error deleting notification" });
      }
    });

    // Clear all notifications
    app.delete(
      "/notifications/clear-all",
      verifyFBToken,
      verifyAdminRole,
      async (req, res) => {
        try {
          const result = await notificationCollection.deleteMany({
            forRole: "admin",
          });
          res.json(result);
        } catch (error) {
          console.error("Clear all error:", error);
          res.status(500).json({ message: "Error clearing notifications" });
        }
      }
    );

    // ============================================
    // UPDATE EXISTING ROUTES TO CREATE NOTIFICATIONS
    // ============================================

    // Update the POST /parcels route to create notification

    // Update POST /riders to create notification

    // Update payment-success to create notification

    // Update delivery status to create notification
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
