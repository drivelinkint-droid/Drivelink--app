require("dotenv").config();

const express = require("express");
const mysql = require("mysql2/promise");
const multer = require("multer");
const nodemailer = require("nodemailer");
const axios = require("axios");
const path = require("path");
const fs = require("fs");

const app = express();

/* =========================================================
   DRIVELINK INT'L - COMPLETE SERVER
   ========================================================= */

const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const PUBLIC_UPLOADS_DIR = path.join(PUBLIC_DIR, "uploads");

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

if (!fs.existsSync(PUBLIC_UPLOADS_DIR)) {
  fs.mkdirSync(PUBLIC_UPLOADS_DIR, { recursive: true });
}

/* =========================================================
   MIDDLEWARE
   ========================================================= */

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

/* =========================================================
   STATIC WEBSITE FILES
   ========================================================= */

app.use(express.static(PUBLIC_DIR));

app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/uploads", express.static(PUBLIC_UPLOADS_DIR));

/* =========================================================
   DATABASE
   ========================================================= */

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT || 3306),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

/* =========================================================
   HELPERS
   ========================================================= */

function safeFilename(filename) {
  if (!filename) return "";

  return path.basename(filename)
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

function cleanImageFilename(value) {
  if (!value) return null;

  let filename = String(value).trim();

  filename = filename
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/^\/+/, "")
    .replace(/^uploads\//i, "")
    .replace(/^public\/uploads\//i, "")
    .replace(/^.*[\\\/]/, "");

  filename = safeFilename(filename);

  return filename || null;
}

function imageFileExists(filename) {
  if (!filename) return false;

  const clean = cleanImageFilename(filename);

  if (!clean) return false;

  const locations = [
    path.join(UPLOADS_DIR, clean),
    path.join(PUBLIC_UPLOADS_DIR, clean)
  ];

  return locations.some(file => {
    try {
      return fs.existsSync(file);
    } catch {
      return false;
    }
  });
}

function findImageFile(filename) {
  if (!filename) return null;

  const clean = cleanImageFilename(filename);

  if (!clean) return null;

  const locations = [
    path.join(UPLOADS_DIR, clean),
    path.join(PUBLIC_UPLOADS_DIR, clean)
  ];

  for (const file of locations) {
    if (fs.existsSync(file)) {
      return file;
    }
  }

  return null;
}

function getBaseUrl(req) {
  const forwardedProto =
    req.headers["x-forwarded-proto"] ||
    req.protocol ||
    "http";

  const forwardedHost =
    req.headers["x-forwarded-host"] ||
    req.get("host");

  return `${forwardedProto}://${forwardedHost}`;
}

function getImageUrl(req, value) {
  if (!value) return null;

  const clean = cleanImageFilename(value);

  if (!clean) return null;

  return `${getBaseUrl(req)}/uploads/${encodeURIComponent(clean)}`;
}

function normalizeImagePath(value) {
  if (!value) return null;

  const clean = cleanImageFilename(value);

  return clean || null;
}

function formatVehicle(req, vehicle) {
  const imageFields = [
    vehicle.image1,
    vehicle.image2,
    vehicle.image3,
    vehicle.image4
  ];

  const images = imageFields
    .map(image => getImageUrl(req, image))
    .filter(Boolean);

  return {
    ...vehicle,

    image1: getImageUrl(req, vehicle.image1),
    image2: getImageUrl(req, vehicle.image2),
    image3: getImageUrl(req, vehicle.image3),
    image4: getImageUrl(req, vehicle.image4),

    images,

    image_count: images.length,

    images_available: imageFields
      .filter(Boolean)
      .map(image => ({
        filename: cleanImageFilename(image),
        available: imageFileExists(image)
      }))
  };
}

function formatVehicles(req, vehicles) {
  return vehicles.map(vehicle => formatVehicle(req, vehicle));
}

function normalizePhone(phone) {
  if (!phone) return "";

  let value = String(phone)
    .trim()
    .replace(/\s+/g, "")
    .replace(/-/g, "");

  if (value.startsWith("+254")) {
    return "254" + value.substring(4);
  }

  if (value.startsWith("00254")) {
    return "254" + value.substring(5);
  }

  if (value.startsWith("07") || value.startsWith("01")) {
    return "254" + value.substring(1);
  }

  if (value.startsWith("7") || value.startsWith("1")) {
    return "254" + value;
  }

  return value;
}

/* =========================================================
   MULTER
   ========================================================= */

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOADS_DIR);
  },

  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || "")
      .toLowerCase()
      .replace(/[^a-z0-9.]/g, "");

    const base = path.basename(
      file.originalname || "vehicle",
      path.extname(file.originalname || "")
    )
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .substring(0, 60);

    const filename =
      `${Date.now()}-${Math.round(Math.random() * 1e9)}-${base || "vehicle"}${ext}`;

    cb(null, filename);
  }
});

const upload = multer({
  storage,

  limits: {
    files: 4,
    fileSize: 5 * 1024 * 1024
  },

  fileFilter: function (req, file, cb) {
    const allowed = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp"
    ];

    if (!allowed.includes(file.mimetype)) {
      return cb(
        new Error("Only JPG, JPEG, PNG and WEBP images are allowed.")
      );
    }

    cb(null, true);
  }
});

/* =========================================================
   ADMIN AUTH
   ========================================================= */

function requireAdmin(req, res, next) {
  const username = req.headers["x-admin-user"];
  const password = req.headers["x-admin-password"];

  if (
    username !== process.env.ADMIN_USER ||
    password !== process.env.ADMIN_PASSWORD
  ) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized"
    });
  }

  next();
}

/* =========================================================
   HEALTH
   ========================================================= */

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      success: true,
      status: "online",
      database: "connected",
      port: PORT
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      status: "online",
      database: "error",
      error: error.message
    });
  }
});

/* =========================================================
   API HOME
   ========================================================= */

app.get("/api", (req, res) => {
  res.json({
    success: true,
    message: "DriveLink Int'l API is running",
    version: "1.0.0"
  });
});

/* =========================================================
   DATABASE TEST
   ========================================================= */

app.get("/api/database-test", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT 1 AS connected");

    res.json({
      success: true,
      database: "connected",
      result: rows
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      database: "error",
      error: error.message
    });
  }
});

/* =========================================================
   DATABASE DIAGNOSTICS
   ========================================================= */

app.get("/api/db-diagnostics", async (req, res) => {
  try {
    const [tables] = await pool.query("SHOW TABLES");

    let vehiclesColumns = [];

    try {
      const [columns] = await pool.query(
        "SHOW COLUMNS FROM vehicles"
      );

      vehiclesColumns = columns;
    } catch (error) {
      vehiclesColumns = {
        error: error.message
      };
    }

    res.json({
      success: true,
      database: process.env.DB_NAME,
      tables,
      vehiclesColumns
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/* =========================================================
   UPLOAD DIAGNOSTICS
   ========================================================= */

app.get("/api/uploads-diagnostics", async (req, res) => {
  try {
    const uploadFiles = fs.existsSync(UPLOADS_DIR)
      ? fs.readdirSync(UPLOADS_DIR)
      : [];

    const publicUploadFiles = fs.existsSync(PUBLIC_UPLOADS_DIR)
      ? fs.readdirSync(PUBLIC_UPLOADS_DIR)
      : [];

    res.json({
      success: true,
      uploads_directory: UPLOADS_DIR,
      uploads_exists: fs.existsSync(UPLOADS_DIR),
      uploads_files: uploadFiles,
      public_uploads_directory: PUBLIC_UPLOADS_DIR,
      public_uploads_exists: fs.existsSync(PUBLIC_UPLOADS_DIR),
      public_uploads_files: publicUploadFiles
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/* =========================================================
   DIRECT IMAGE SERVING
   ========================================================= */

app.get("/uploads/:filename", (req, res) => {
  const filename = safeFilename(req.params.filename);

  if (!filename) {
    return res.status(400).send("Invalid filename");
  }

  const file = findImageFile(filename);

  if (!file) {
    return res.status(404).send("Image not found");
  }

  res.sendFile(file);
});

/* =========================================================
   PUBLIC VEHICLES
   ========================================================= */

app.get("/api/public/vehicles", async (req, res) => {
  try {
    console.log("DB config:", {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME
});
    const [rows] = await pool.query(
      `SELECT *
       FROM vehicles
       WHERE status = 'approved'
       ORDER BY created_at DESC`
    );

    res.json({
      success: true,
      vehicles: formatVehicles(req, rows)
    });
  } catch (error) {
    console.error("Public vehicles error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to load vehicles",
      error: error.message
    });
  }
});

/* =========================================================
   GET ALL VEHICLES
   ========================================================= */

app.get("/api/vehicles", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT *
       FROM vehicles
       ORDER BY created_at DESC`
    );

    res.json({
      success: true,
      vehicles: formatVehicles(req, rows)
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/* =========================================================
   GET APPROVED VEHICLES
   ========================================================= */

app.get("/api/vehicles/approved", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT *
       FROM vehicles
       WHERE status = 'approved'
       ORDER BY created_at DESC`
    );

    res.json({
      success: true,
      vehicles: formatVehicles(req, rows)
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/* =========================================================
   SUBMIT VEHICLE
   ========================================================= */

app.post(
  "/api/vehicles",
  upload.array("images", 4),
  async (req, res) => {
    try {
      const {
        owner_name,
        owner_phone,
        owner_email,
        vehicle_make,
        vehicle_model,
        year,
        registration_number,
        daily_price,
        location,
        transmission,
        fuel_type,
        seats,
        description,
        driving_option,
        driver_rate,
        driver_daily_rate
      } = req.body;

      if (
        !owner_name ||
        !owner_phone ||
        !owner_email ||
        !vehicle_make ||
        !vehicle_model ||
        !daily_price ||
        !location
      ) {
        if (req.files) {
          req.files.forEach(file => {
            try {
              fs.unlinkSync(file.path);
            } catch {}
          });
        }

        return res.status(400).json({
          success: false,
          message: "Please complete all required fields."
        });
      }

      const images = (req.files || [])
        .map(file => file.filename)
        .slice(0, 4);

      const image1 = images[0] || null;
      const image2 = images[1] || null;
      const image3 = images[2] || null;
      const image4 = images[3] || null;

      const finalDriverRate =
        driver_daily_rate ||
        driver_rate ||
        null;

      const [result] = await pool.query(
        `INSERT INTO vehicles
        (
          owner_name,
          owner_phone,
          owner_email,
          vehicle_make,
          vehicle_model,
          year,
          registration_number,
          daily_price,
          location,
          transmission,
          fuel_type,
          seats,
          description,
          image1,
          image2,
          image3,
          image4,
          status,
          driving_option,
          driver_rate
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [
          owner_name,
          normalizePhone(owner_phone),
          owner_email,
          vehicle_make,
          vehicle_model,
          year || null,
          registration_number || null,
          daily_price,
          location,
          transmission || null,
          fuel_type || null,
          seats || null,
          description || null,
          image1,
          image2,
          image3,
          image4,
          driving_option || "self_drive",
          finalDriverRate
        ]
      );

      res.status(201).json({
        success: true,
        message:
          "Vehicle submitted successfully and is awaiting approval.",
        vehicle_id: result.insertId
      });

    } catch (error) {
      console.error("Vehicle submission error:", error);

      if (req.files) {
        req.files.forEach(file => {
          try {
            if (fs.existsSync(file.path)) {
              fs.unlinkSync(file.path);
            }
          } catch {}
        });
      }

      res.status(500).json({
        success: false,
        message: "Vehicle submission failed.",
        error: error.message
      });
    }
  }
);

/* =========================================================
   ADMIN - GET VEHICLES
   ========================================================= */

app.get(
  "/api/admin/vehicles",
  requireAdmin,
  async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT *
         FROM vehicles
         ORDER BY created_at DESC`
      );

      res.json({
        success: true,
        vehicles: formatVehicles(req, rows)
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   ADMIN - APPROVE
   ========================================================= */

app.post(
  "/api/admin/vehicles/:id/approve",
  requireAdmin,
  async (req, res) => {
    try {
      const [result] = await pool.query(
        `UPDATE vehicles
         SET status = 'approved'
         WHERE id = ?`,
        [req.params.id]
      );

      res.json({
        success: true,
        message: "Vehicle approved.",
        affectedRows: result.affectedRows
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   ADMIN - REJECT
   ========================================================= */

app.post(
  "/api/admin/vehicles/:id/reject",
  requireAdmin,
  async (req, res) => {
    try {
      const [result] = await pool.query(
        `UPDATE vehicles
         SET status = 'rejected'
         WHERE id = ?`,
        [req.params.id]
      );

      res.json({
        success: true,
        message: "Vehicle rejected.",
        affectedRows: result.affectedRows
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   ADMIN - DELETE VEHICLE
   ========================================================= */

app.delete(
  "/api/admin/vehicles/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT image1, image2, image3, image4
         FROM vehicles
         WHERE id = ?`,
        [req.params.id]
      );

      if (rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Vehicle not found."
        });
      }

      const vehicle = rows[0];

      const images = [
        vehicle.image1,
        vehicle.image2,
        vehicle.image3,
        vehicle.image4
      ];

      images.forEach(image => {
        const file = findImageFile(image);

        if (file) {
          try {
            fs.unlinkSync(file);
          } catch {}
        }
      });

      await pool.query(
        `DELETE FROM vehicles
         WHERE id = ?`,
        [req.params.id]
      );

      res.json({
        success: true,
        message: "Vehicle deleted."
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   CHECK VEHICLE AVAILABILITY
   ========================================================= */

app.get("/api/vehicles/:id/availability", async (req, res) => {
  try {
    const vehicleId = req.params.id;
    const pickupDate = req.query.pickup_date;
    const returnDate = req.query.return_date;

    if (!pickupDate || !returnDate) {
      return res.status(400).json({
        success: false,
        message: "Pickup and return dates are required."
      });
    }

    const [rows] = await pool.query(
      `SELECT id
       FROM bookings
       WHERE vehicle_id = ?
       AND booking_status NOT IN ('rejected', 'cancelled')
       AND pickup_date < ?
       AND return_date > ?
       LIMIT 1`,
      [
        vehicleId,
        returnDate,
        pickupDate
      ]
    );

    res.json({
      success: true,
      available: rows.length === 0
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/* =========================================================
   BOOKINGS
   ========================================================= */

app.post("/api/bookings", async (req, res) => {
  try {
    const {
      vehicle_id,
      customer_name,
      customer_phone,
      customer_email,
      pickup_date,
      return_date,
      rental_days,
      daily_price,
      service_fee,
      total_amount,
      notes
    } = req.body;

    if (
      !vehicle_id ||
      !customer_name ||
      !customer_phone ||
      !customer_email ||
      !pickup_date ||
      !return_date
    ) {
      return res.status(400).json({
        success: false,
        message: "Please complete all required booking fields."
      });
    }

    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const [vehicles] = await connection.query(
        `SELECT *
         FROM vehicles
         WHERE id = ?
         AND status = 'approved'
         FOR UPDATE`,
        [vehicle_id]
      );

      if (vehicles.length === 0) {
        await connection.rollback();

        return res.status(404).json({
          success: false,
          message: "Vehicle not found or is not available."
        });
      }

      const [existingBookings] = await connection.query(
        `SELECT id
         FROM bookings
         WHERE vehicle_id = ?
         AND booking_status NOT IN ('rejected', 'cancelled')
         AND pickup_date < ?
         AND return_date > ?
         LIMIT 1`,
        [
          vehicle_id,
          return_date,
          pickup_date
        ]
      );

      if (existingBookings.length > 0) {
        await connection.rollback();

        return res.status(409).json({
          success: false,
          message:
            "This vehicle is already booked for some or all of the selected dates."
        });
      }

      const vehicle = vehicles[0];

      const days =
        Number(rental_days) ||
        Math.max(
          1,
          Math.ceil(
            (
              new Date(return_date) -
              new Date(pickup_date)
            ) /
            (1000 * 60 * 60 * 24)
          )
        );

      const price =
        Number(daily_price) ||
        Number(vehicle.daily_price) ||
        0;

      const fee =
        Number(service_fee) || 0;

      const total =
        Number(total_amount) ||
        (price * days) + fee;

      const [result] = await connection.query(
        `INSERT INTO bookings
        (
          vehicle_id,
          customer_name,
          customer_phone,
          customer_email,
          pickup_date,
          return_date,
          rental_days,
          daily_price,
          service_fee,
          total_amount,
          payment_status,
          booking_status,
          notes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?)`,
        [
          vehicle_id,
          customer_name,
          normalizePhone(customer_phone),
          customer_email,
          pickup_date,
          return_date,
          days,
          price,
          fee,
          total,
          notes || null
        ]
      );

      await connection.commit();

      res.status(201).json({
        success: true,
        message:
          "Booking received successfully.",
        booking_id: result.insertId,
        total_amount: total
      });

    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

  } catch (error) {
    console.error("Booking error:", error);

    res.status(500).json({
      success: false,
      message: "Booking failed.",
      error: error.message
    });
  }
});

/* =========================================================
   ADMIN - BOOKINGS
   ========================================================= */

app.get(
  "/api/admin/bookings",
  requireAdmin,
  async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT
          b.*,
          v.vehicle_make,
          v.vehicle_model,
          v.year,
          v.registration_number
         FROM bookings b
         LEFT JOIN vehicles v
         ON b.vehicle_id = v.id
         ORDER BY b.id DESC`
      );

      res.json({
        success: true,
        bookings: rows
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   ADMIN - ACCEPT BOOKING
   ========================================================= */

app.post(
  "/api/admin/bookings/:id/accept",
  requireAdmin,
  async (req, res) => {
    try {
      const [result] = await pool.query(
        `UPDATE bookings
         SET booking_status = 'accepted'
         WHERE id = ?`,
        [req.params.id]
      );

      res.json({
        success: true,
        message: "Booking accepted.",
        affectedRows: result.affectedRows
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   ADMIN - REJECT BOOKING
   ========================================================= */

app.post(
  "/api/admin/bookings/:id/reject",
  requireAdmin,
  async (req, res) => {
    try {
      const [result] = await pool.query(
        `UPDATE bookings
         SET booking_status = 'rejected'
         WHERE id = ?`,
        [req.params.id]
      );

      res.json({
        success: true,
        message: "Booking rejected.",
        affectedRows: result.affectedRows
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   CONTACT FORM
   ========================================================= */

app.post("/api/contact", async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      enquiry_type,
      subject,
      message
    } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({
        success: false,
        message: "Name, email and message are required."
      });
    }

    const [result] = await pool.query(
      `INSERT INTO contact_messages
      (
        name,
        email,
        phone,
        enquiry_type,
        subject,
        message,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, 'new')`,
      [
        name,
        email,
        phone || null,
        enquiry_type || null,
        subject || null,
        message
      ]
    );

    /* Optional email notification */

    if (
      process.env.SMTP_HOST &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASSWORD
    ) {
      try {
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT || 587),
          secure:
            String(process.env.SMTP_SECURE).toLowerCase() === "true",
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASSWORD
          }
        });

        await transporter.sendMail({
          from:
            process.env.SMTP_FROM ||
            process.env.SMTP_USER,

          to:
            process.env.CONTACT_EMAIL ||
            "drivelinkint@gmail.com",

          subject:
            `DriveLink Contact: ${subject || enquiry_type || "New enquiry"}`,

          text:
            `Name: ${name}\n` +
            `Email: ${email}\n` +
            `Phone: ${phone || "N/A"}\n` +
            `Enquiry: ${enquiry_type || "N/A"}\n` +
            `Subject: ${subject || "N/A"}\n\n` +
            `${message}`
        });

      } catch (mailError) {
        console.error(
          "Contact email notification failed:",
          mailError.message
        );
      }
    }

    res.status(201).json({
      success: true,
      message:
        "Your message has been sent successfully.",
      message_id: result.insertId
    });

  } catch (error) {
    console.error("Contact error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to send your message.",
      error: error.message
    });
  }
});

/* =========================================================
   ADMIN - CONTACT MESSAGES
   ========================================================= */

app.get(
  "/api/contact/messages",
  requireAdmin,
  async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT *
         FROM contact_messages
         ORDER BY id DESC`
      );

      res.json({
        success: true,
        messages: rows
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   ADMIN - CONTACT STATUS
   ========================================================= */

app.post(
  "/api/admin/contact/:id/status",
  requireAdmin,
  async (req, res) => {
    try {
      const status = req.body.status || "read";

      const [result] = await pool.query(
        `UPDATE contact_messages
         SET status = ?
         WHERE id = ?`,
        [
          status,
          req.params.id
        ]
      );

      res.json({
        success: true,
        message: "Contact status updated.",
        affectedRows: result.affectedRows
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   ADMIN - DELETE CONTACT MESSAGE
   ========================================================= */

app.delete(
  "/api/admin/contact/:id",
  requireAdmin,
  async (req, res) => {
    try {
      await pool.query(
        `DELETE FROM contact_messages
         WHERE id = ?`,
        [req.params.id]
      );

      res.json({
        success: true,
        message: "Contact message deleted."
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   M-PESA - ACCESS TOKEN
   ========================================================= */

async function getMpesaAccessToken() {
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;

  if (!consumerKey || !consumerSecret) {
    throw new Error(
      "M-Pesa consumer key or consumer secret is missing."
    );
  }

  const environment =
    String(process.env.MPESA_ENVIRONMENT || "sandbox")
      .toLowerCase();

  const baseUrl =
    environment === "production"
      ? "https://api.safaricom.co.ke"
      : "https://sandbox.safaricom.co.ke";

  const credentials =
    Buffer
      .from(`${consumerKey}:${consumerSecret}`)
      .toString("base64");

  const response = await axios.get(
    `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        Authorization: `Basic ${credentials}`
      }
    }
  );

  return {
    token: response.data.access_token,
    baseUrl
  };
}

/* =========================================================
   M-PESA - STK PUSH
   ========================================================= */

app.post("/api/mpesa/stkpush", async (req, res) => {
  try {
    const {
      phone,
      amount,
      account_reference,
      transaction_desc
    } = req.body;

    if (!phone || !amount) {
      return res.status(400).json({
        success: false,
        message: "Phone number and amount are required."
      });
    }

    const shortcode =
      process.env.MPESA_SHORTCODE ||
      process.env.MPESA_BUSINESS_SHORTCODE;

    const passkey =
      process.env.MPESA_PASSKEY;

    const callbackUrl =
      process.env.MPESA_CALLBACK_URL;

    if (!shortcode || !passkey || !callbackUrl) {
      return res.status(500).json({
        success: false,
        message:
          "M-Pesa configuration is incomplete."
      });
    }

    const {
      token,
      baseUrl
    } = await getMpesaAccessToken();

    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, 14);

    const password =
      Buffer
        .from(
          `${shortcode}${passkey}${timestamp}`
        )
        .toString("base64");

    const normalizedPhone =
      normalizePhone(phone);

    const response = await axios.post(
      `${baseUrl}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType:
          process.env.MPESA_TRANSACTION_TYPE ||
          "CustomerPayBillOnline",

        Amount: Math.round(Number(amount)),

        PartyA: normalizedPhone,

        PartyB: shortcode,

        PhoneNumber: normalizedPhone,

        CallBackURL: callbackUrl,

        AccountReference:
          account_reference ||
          "DriveLink",

        TransactionDesc:
          transaction_desc ||
          "DriveLink vehicle booking"
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.json({
      success: true,
      mpesa: response.data
    });

  } catch (error) {
    console.error(
      "M-Pesa STK error:",
      error.response?.data ||
      error.message
    );

    res.status(500).json({
      success: false,
      message: "M-Pesa payment request failed.",
      error:
        error.response?.data ||
        error.message
    });
  }
});

/* =========================================================
   M-PESA CALLBACK
   ========================================================= */

app.post("/api/mpesa/callback", async (req, res) => {
  console.log(
    "M-Pesa callback:",
    JSON.stringify(req.body, null, 2)
  );

  try {
    const callback =
      req.body?.Body?.stkCallback;

    if (!callback) {
      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted"
      });
    }

    const resultCode =
      callback.ResultCode;

    const resultDesc =
      callback.ResultDesc;

    console.log(
      "M-Pesa Result:",
      resultCode,
      resultDesc
    );

    let amount = null;
    let receipt = null;
    let phone = null;

    const metadata =
      callback.CallbackMetadata?.Item || [];

    metadata.forEach(item => {
      if (item.Name === "Amount") {
        amount = item.Value;
      }

      if (item.Name === "MpesaReceiptNumber") {
        receipt = item.Value;
      }

      if (item.Name === "PhoneNumber") {
        phone = item.Value;
      }
    });

    console.log({
      resultCode,
      resultDesc,
      amount,
      receipt,
      phone
    });

  } catch (error) {
    console.error(
      "M-Pesa callback error:",
      error.message
    );
  }

  res.json({
    ResultCode: 0,
    ResultDesc: "Accepted"
  });
});

/* =========================================================
   WEBSITE ROOT
   ========================================================= */

app.get("/", (req, res) => {
  const indexFile =
    path.join(PUBLIC_DIR, "index.html");

  if (!fs.existsSync(indexFile)) {
    return res.status(404).send(
      `
      <h1>DriveLink website files not found</h1>
      <p>index.html should be inside the public folder.</p>
      `
    );
  }

  res.sendFile(indexFile);
});

/* =========================================================
   COMMON WEBSITE ROUTES
   ========================================================= */

const websitePages = [
  "index",
  "vehicles",
  "booking",
  "list-your-car",
  "how-it-works",
  "contact",
  "admin"
];

websitePages.forEach(page => {
  app.get(`/${page}`, (req, res) => {
    const file = path.join(
      PUBLIC_DIR,
      `${page}.html`
    );

    if (fs.existsSync(file)) {
      return res.sendFile(file);
    }

    res.status(404).send(
      `${page}.html not found`
    );
  });
});

/* =========================================================
   404 API / WEBSITE HANDLER
   ========================================================= */

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      success: false,
      message: "API endpoint not found"
    });
  }

  res.status(404).send(
    `
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>DriveLink Int'l</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>
        body {
          font-family: Arial, sans-serif;
          text-align: center;
          padding: 60px 20px;
          background: #f5f5f5;
        }

        h1 {
          margin-bottom: 10px;
        }

        a {
          display: inline-block;
          margin-top: 20px;
          padding: 12px 20px;
          background: #111820;
          color: white;
          text-decoration: none;
          border-radius: 6px;
        }
      </style>
    </head>
    <body>
      <h1>Page not found</h1>
      <p>The page you requested does not exist.</p>
      <a href="/">Return to DriveLink</a>
    </body>
    </html>
    `
  );
});

/* =========================================================
   ERROR HANDLER
   ========================================================= */

app.use((error, req, res, next) => {
  console.error("Server error:", error);

  if (
    error instanceof multer.MulterError
  ) {
    return res.status(400).json({
      success: false,
      message: error.message
    });
  }

  res.status(500).json({
    success: false,
    message:
      error.message ||
      "Internal server error"
  });
});

/* =========================================================
   START SERVER
   ========================================================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `DriveLink Int'l server running on port ${PORT}`
  );

  console.log(
    `Website: http://localhost:${PORT}`
  );

  console.log(
    `API: http://localhost:${PORT}/api`
  );

  console.log(
    `Health: http://localhost:${PORT}/health`
  );
});



