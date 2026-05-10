// server.js
import express from "express";
import cors from "cors";
import db from "./app/models/index.js";
import authRoutes from "./app/routes/auth.routes.js";
import userRoutes from "./app/routes/user.routes.js";
 
const app = express();
 
const corsOptions = {
    origin: "http://localhost:8081",
};
 
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
 
// Simple test route
app.get("/", (req  , res) => {
    res.json({ message: "Welcome to the Node.js JWT Authentication API." });
});
 
// Routes
app.use("/api/auth", authRoutes);
app.use("/api/test", userRoutes);
 
// Set port and listen for requests
const PORT = process.env.PORT || 8080;
 
db.sequelize.sync({ force: false }).then(() => {
    console.log("Database synchronized");
    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}.`);
    });
});