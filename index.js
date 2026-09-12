import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import submissionsRoutes from "./routes/submissions.js";
import approvedRoutes from "./routes/approved.js";
import uploadsRoutes from "./routes/uploads.js";
import referenceRoutes from "./routes/reference.js";
import path from "path";
import { fileURLToPath } from "url";
import collaborationRoutes from "./routes/collaboration.js";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import jwt from "jsonwebtoken";
import Collaboration from "./models/Collaboration.js";
import { dbConnect } from "./utils/db.js";
import Amendment from "./routes/Amendment.js"
import revisionsRoutes from "./routes/revisions.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// ===== CORS Configuration =====
const corsOptions = {
  origin: [`${process.env.FRONTEND_URL}`],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

// ===== Middleware =====
app.use(cors(corsOptions));
app.use(express.json());

// ===== API Routes =====
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/submissions", submissionsRoutes);
app.use("/api/approved", approvedRoutes);
app.use("/api/uploads", uploadsRoutes);
app.use("/api/reference", referenceRoutes);
app.use("/api/collab", collaborationRoutes);
app.use("/api/amendments", Amendment);
app.use("/api/submissions", revisionsRoutes);

// ===== Health Check Endpoint =====
app.get("/api/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toLocaleString() });
});

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Heritage Repository API</title>
      <style>
        :root { color-scheme: light dark; }
        * { box-sizing: border-box; }
        body {
          margin: 0;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          padding: 24px;
        }
        .card {
          max-width: 520px;
          width: 100%;
          border: 1px solid rgba(128, 128, 128, 0.25);
          border-radius: 16px;
          padding: 40px;
          text-align: center;
        }
        .status-dot {
          display: inline-block;
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: #22c55e;
          box-shadow: 0 0 8px #22c55e;
          margin-right: 8px;
        }
        h1 {
          font-size: 1.5rem;
          margin: 16px 0 8px;
        }
        p.subtitle {
          color: #94a3b8;
          margin: 0 0 28px;
          font-size: 0.95rem;
        }
        .status-pill {
          display: inline-flex;
          align-items: center;
          background: rgba(34, 197, 94, 0.12);
          border: 1px solid rgba(34, 197, 94, 0.3);
          color: #4ade80;
          padding: 6px 14px;
          border-radius: 999px;
          font-size: 0.85rem;
          font-weight: 600;
          letter-spacing: 0.02em;
        }
        .links {
          margin-top: 28px;
          display: flex;
          gap: 12px;
          justify-content: center;
          flex-wrap: wrap;
        }
        .links a {
          color: #93c5fd;
          text-decoration: none;
          font-size: 0.9rem;
          border: 1px solid rgba(147, 197, 253, 0.3);
          padding: 8px 16px;
          border-radius: 8px;
          transition: background 0.15s ease;
        }
        .links a:hover {
          background: rgba(147, 197, 253, 0.1);
        }
        footer {
          margin-top: 24px;
          font-size: 0.75rem;
          color: #64748b;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <span class="status-pill"><span class="status-dot"></span>Online</span>
        <h1>Heritage Repository</h1>
        <p class="subtitle">Backend server is up and running.</p>
        <div class="links">
          <a href="/api/health">Health Check</a>
        </div>
        <footer>${new Date().toLocaleString()}</footer>
      </div>
    </body>
    </html>
  `);
});


// Graceful shutdown handler
const gracefulShutdown = (server) => {
  return (signal) => {
    console.log(`\n${signal} received. Starting graceful shutdown...`);

    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });

    // Force shutdown after 10 seconds
    setTimeout(() => {
      console.error("Forced shutdown after timeout");
      process.exit(1);
    }, 10000);
  };
};

const startServer = async () => {
  try {
    await dbConnect();

    const server = createServer(app);

    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🗄️  MongoDB: Connected successfully`);
      console.log(`📦 Image storage ready`);
      // console.log(`📝 Environment: ${NODE_ENV || "development"}`);
      // console.log(`⚡ Redis: Cache layer active`);
      // console.log(`🔗 Socket.IO enabled`);
    });
    // Handle server errors
    server.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        console.error(`Port ${PORT} is already in use`);
      } else {
        console.error("Server error:", error);
      }
      process.exit(1);
    });

    // Graceful shutdown on signals
    process.on("SIGTERM", gracefulShutdown(server));
    process.on("SIGINT", gracefulShutdown(server));

    // Handle uncaught exceptions
    process.on("uncaughtException", (error) => {
      console.error("Uncaught Exception:", error);
      gracefulShutdown(server)("uncaughtException");
    });

    // Handle unhandled promise rejections
    process.on("unhandledRejection", (reason, promise) => {
      console.error("Unhandled Rejection at:", promise, "reason:", reason);
      gracefulShutdown(server)("unhandledRejection");
    });
  } catch (err) {
    console.error("Failed to start server:", err.message);
    process.exit(1);
  }
};

startServer();
