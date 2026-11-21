import { Router } from "express";
import {
  getMyEnrollments,
  initiateEnrollment,
  verifyEnrollment,
  initiateOrderPayment,
  verifyOrderPayment,
  createCodOrder,
  handlePayUResponse,
} from "../controllers/paymentController.js";
import { getMyOrders } from "../controllers/orderController.js";
import { requireUser, optionalUser } from "../lib/auth.js";

const router = Router();

// PayU Response Callback (POST from PayU gateway)
router.post("/payu/response", handlePayUResponse);

// Training enrollments
router.get("/my-enrollments", requireUser, getMyEnrollments);
router.post("/payu/initiate-enrollment", optionalUser, initiateEnrollment);
router.post("/payu/verify-enrollment", verifyEnrollment);

// Product orders
router.get("/my-orders", requireUser, getMyOrders);
router.post("/payu/initiate-order", optionalUser, initiateOrderPayment);
router.post("/payu/verify-order", verifyOrderPayment);
router.post("/cod-order", optionalUser, createCodOrder);

export default router;
