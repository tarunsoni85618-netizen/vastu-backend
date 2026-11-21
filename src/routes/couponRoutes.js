import { Router } from "express";
import { validateCouponHandler } from "../controllers/couponController.js";

const router = Router();

// Validate and apply coupon for user checkout
router.post("/apply", validateCouponHandler);

export default router;
