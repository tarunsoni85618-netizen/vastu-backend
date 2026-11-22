import { Router } from "express";
import {
  getMyEnrollments,
  initiateEnrollment,
  verifyEnrollment,
  initiateOrderPayment,
  verifyOrderPayment,
  verifyGeneralPayment,
  createCodOrder,
  handlePaymentResponse,
  handlePayUResponse,
} from "../controllers/paymentController.js";
import { getMyOrders } from "../controllers/orderController.js";
import { requireUser, optionalUser } from "../lib/auth.js";

const router = Router();

// Gateway Response Callback
router.post("/response", handlePaymentResponse);
router.post("/payu/response", handlePayUResponse); // alias

// Unified general verification
router.post("/verify", verifyGeneralPayment);

// Training enrollments
router.get("/my-enrollments", optionalUser, getMyEnrollments);
router.post("/initiate-enrollment", optionalUser, initiateEnrollment);
router.post("/verify-enrollment", verifyEnrollment);
router.post("/payu/initiate-enrollment", optionalUser, initiateEnrollment); // legacy alias
router.post("/payu/verify-enrollment", verifyEnrollment); // legacy alias

// Product orders
router.get("/my-orders", optionalUser, getMyOrders);
router.post("/initiate-order", optionalUser, initiateOrderPayment);
router.post("/verify-order", verifyOrderPayment);
router.post("/payu/initiate-order", optionalUser, initiateOrderPayment); // legacy alias
router.post("/payu/verify-order", verifyOrderPayment); // legacy alias
router.post("/cod-order", optionalUser, createCodOrder);

export default router;
