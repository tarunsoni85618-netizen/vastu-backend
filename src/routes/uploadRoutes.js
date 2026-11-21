import { Router } from "express";
import { signUpload, uploadImage } from "../controllers/uploadController.js";
import { requireAdmin } from "../lib/auth.js";

const router = Router();

// Protect image upload endpoints with admin authentication
router.post("/sign", requireAdmin, signUpload);
router.post("/image", requireAdmin, uploadImage);

export default router;
