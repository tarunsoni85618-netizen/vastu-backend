import { connectDB } from "../lib/dbConnect.js";
import Enrollment from "../models/Enrollment.js";
import Training from "../models/Training.js";
import Order from "../models/Order.js";
import User from "../models/User.js";
import Donation from "../models/Donation.js";
import Consultation from "../models/Consultation.js";
import Coupon from "../models/Coupon.js";
import { verifyOrderCalculation } from "./couponController.js";
import {
  createRazorpayOrder,
  verifyRazorpaySignature,
  isRazorpayConfigured,
  getRazorpayKeyId,
} from "../lib/razorpay.js";
import {
  getPaymentSuccessUrl,
  getPaymentFailureUrl,
  getFrontendUrl,
} from "../lib/redirects.js";

const DEFAULT_COURSE_WHATSAPP_LINKS = {
  "bhuwneshwari scientific vastu master class":
    "https://chat.whatsapp.com/BhuwneshwariMasterClass",
  "advanced vastu workshop":
    "https://chat.whatsapp.com/AdvancedVastuWorkshop",
  "personalized vastu training":
    "https://chat.whatsapp.com/PersonalizedVastuTraining",
};

function getWhatsappLinkForCourse(title = "", customLink = "") {
  if (customLink && customLink.trim()) return customLink.trim();
  const normalized = title.trim().toLowerCase();
  return (
    DEFAULT_COURSE_WHATSAPP_LINKS[normalized] ||
    process.env.DEFAULT_WHATSAPP_LINK ||
    "https://chat.whatsapp.com/BhuwneshwariVastu"
  );
}

const digitsOnly = (v = "") => String(v).replace(/\D/g, "");

/**
 * Check if current user is enrolled in a specific program or get all user enrollments
 */
export async function getMyEnrollments(req, res) {
  try {
    await connectDB();
    const phoneParam = req.query?.phone ? digitsOnly(req.query.phone).slice(-10) : "";
    const phone = req.user?.phone ? digitsOnly(req.user.phone || "").slice(-10) : phoneParam;
    const email = req.user?.email ? String(req.user.email).trim().toLowerCase() : (req.query?.email ? String(req.query.email).trim().toLowerCase() : "");
    const userId = req.user?.id || req.user?._id;

    if (!userId && (!phone || phone.length < 10) && !email) {
      return res.status(401).json({ success: false, error: "Authentication required" });
    }

    const conditions = [];
    if (phone && phone.length >= 10) {
      conditions.push({ userPhone: { $regex: new RegExp(phone + "$") } });
    }
    if (email) {
      conditions.push({ userEmail: email });
    }

    if (conditions.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const enrollments = await Enrollment.find({
      $or: conditions,
      paymentStatus: "paid",
    })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ success: true, data: enrollments });
  } catch (error) {
    console.error("getMyEnrollments error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Unable to retrieve enrollments" });
  }
}

/**
 * Initiate PayU payment for Training enrollment
 */
export async function initiateEnrollment(req, res) {
  try {
    await connectDB();
    const {
      courseTitle,
      courseSlug = "",
      amount,
      name = "",
      email = "",
      phone = "",
    } = req.body;

    const cleanedPhone = digitsOnly(phone);
    if (!cleanedPhone || cleanedPhone.length < 10) {
      return res.status(400).json({
        success: false,
        error: "A valid mobile number is required for enrollment",
      });
    }

    if (!courseTitle || !amount || Number(amount) <= 0) {
      return res.status(400).json({
        success: false,
        error: "Valid course and amount are required",
      });
    }

    // Check if user is ALREADY enrolled and paid for this course
    const existing = await Enrollment.findOne({
      userPhone: cleanedPhone,
      courseTitle: { $regex: new RegExp(`^${courseTitle.trim()}$`, "i") },
      paymentStatus: "paid",
    }).lean();

    if (existing) {
      return res.status(400).json({
        success: false,
        alreadyEnrolled: true,
        error: "You are already enrolled in this training program.",
        enrollment: existing,
      });
    }

    // Fetch custom WhatsApp link from Training model if configured
    const trainingDoc = await Training.findOne({
      $or: [
        { title: { $regex: new RegExp(`^${courseTitle.trim()}$`, "i") } },
        { slug: courseSlug },
      ],
    }).lean();

    const whatsappLink = getWhatsappLinkForCourse(
      courseTitle,
      trainingDoc?.whatsappLink
    );

    const enrollmentId = `BSV-ENR-${Date.now().toString().slice(-6)}`;
    const txnid = `TXN_ENR_${Date.now()}_${Math.random()
      .toString(36)
      .substring(2, 7)
      .toUpperCase()}`;

    // Look up user if exists
    const userDoc = await User.findOne({ phone: cleanedPhone }).lean();

    // Create or update pending enrollment
    await Enrollment.findOneAndUpdate(
      {
        userPhone: cleanedPhone,
        courseTitle: courseTitle.trim(),
        paymentStatus: { $ne: "paid" },
      },
      {
        enrollmentId,
        user: userDoc?._id || undefined,
        userPhone: cleanedPhone,
        userName: name.trim(),
        userEmail: email.trim(),
        courseTitle: courseTitle.trim(),
        courseSlug: courseSlug.trim(),
        amount: Number(amount),
        currency: "INR",
        paymentStatus: "pending",
        paymentProvider: "online",
        txnid,
        whatsappLink,
        status: "active",
      },
      { upsert: true, new: true }
    );

    const rzpOrder = await createRazorpayOrder({
      amount,
      receipt: enrollmentId,
      notes: {
        enrollmentId,
        type: "training",
        courseTitle: courseTitle.trim().slice(0, 50),
      },
    });

    if (rzpOrder?.orderId) {
      await Enrollment.updateOne(
        { enrollmentId },
        { $set: { paymentReference: rzpOrder.orderId } }
      );
    }

    return res.json({
      success: true,
      provider: "razorpay",
      keyId: rzpOrder.keyId,
      orderId: rzpOrder.orderId,
      amount: rzpOrder.amount,
      currency: rzpOrder.currency,
      enrollmentId,
      txnid,
      whatsappLink,
      customer: {
        name: name.trim(),
        email: email.trim(),
        phone: cleanedPhone,
      },
    });
  } catch (error) {
    console.error("initiateEnrollment error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Unable to initiate enrollment" });
  }
}

/**
 * Verify Razorpay payment for Training enrollment
 */
export async function verifyEnrollment(req, res) {
  try {
    await connectDB();
    const data = req.body || {};
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      txnid,
      enrollmentId,
    } = data;

    if (!txnid && !enrollmentId && !razorpay_order_id) {
      return res.status(400).json({
        success: false,
        error: "Missing transaction ID or enrollment ID",
      });
    }

    const enrollment = await Enrollment.findOne({
      $or: [
        ...(enrollmentId ? [{ enrollmentId }] : []),
        ...(txnid ? [{ txnid }] : []),
        ...(razorpay_order_id ? [{ paymentReference: razorpay_order_id }] : []),
      ],
    });

    if (!enrollment) {
      return res
        .status(404)
        .json({ success: false, error: "Enrollment record not found" });
    }

    if (enrollment.paymentStatus === "paid") {
      const redirectUrl = getPaymentSuccessUrl({
        type: "training",
        status: "success",
        enrollmentId: enrollment.enrollmentId,
        course: enrollment.courseTitle,
        txnid: enrollment.paymentReference,
      });
      return res.json({
        success: true,
        message: "Enrollment is already verified and active",
        enrollment,
        redirectUrl,
      });
    }

    const isValid = verifyRazorpaySignature({
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    });

    if (!isValid) {
      enrollment.paymentStatus = "failed";
      await enrollment.save();
      const redirectUrl = getPaymentFailureUrl({
        type: "training",
        status: "failed",
        enrollmentId: enrollment.enrollmentId,
        error: "Payment verification failed",
      });
      return res
        .status(400)
        .json({ success: false, error: "Payment verification failed", redirectUrl });
    }

    enrollment.paymentStatus = "paid";
    enrollment.paidAmount = enrollment.amount;
    enrollment.dueAmount = 0;
    enrollment.paymentType = "full";
    enrollment.paymentProvider = "online";
    enrollment.paymentReference = razorpay_payment_id || razorpay_order_id || txnid;
    await enrollment.save();

    const redirectUrl = getPaymentSuccessUrl({
      type: "training",
      status: "success",
      enrollmentId: enrollment.enrollmentId,
      course: enrollment.courseTitle,
      txnid: enrollment.paymentReference,
    });

    return res.json({
      success: true,
      message: "Payment successfully verified! Enrollment active.",
      enrollment,
      redirectUrl,
    });
  } catch (error) {
    console.error("verifyEnrollment error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Unable to verify enrollment payment" });
  }
}

/**
 * Initiate PayU payment for Product Order Checkout
 */
export async function initiateOrderPayment(req, res) {
  try {
    await connectDB();
    const {
      items = [],
      customer = {},
      coupon = null,
      shippingAddress = {},
      buyerGstin = "",
    } = req.body;

    if (!items.length) {
      return res.status(400).json({
        success: false,
        error: "Cart is empty",
      });
    }

    // Backend Security Verification of products, prices, coupon, 18% GST and shipping
    const verified = await verifyOrderCalculation({
      items,
      couponCode: coupon,
      customer,
    });

    if (verified.verifiedTotal <= 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid total calculation",
      });
    }

    const cleanedPhone = digitsOnly(customer.phone);
    const clean10 = cleanedPhone.slice(-10);
    const orderNumber = `BSV-${Date.now().toString().slice(-8)}`;
    const txnid = `TXN_ORD_${Date.now()}_${Math.random()
      .toString(36)
      .substring(2, 7)
      .toUpperCase()}`;

    // Find user by session or phone if available
    const userId = req.user?.id || req.user?._id;
    let customerId = userId;
    if (!customerId && clean10) {
      const userDoc = await User.findOne({ phone: { $regex: new RegExp(clean10 + "$") } }).lean();
      if (userDoc) customerId = userDoc._id;
    }

    const gstinValue = String(buyerGstin || customer.buyerGstin || customer.gstin || "").trim();

    const rzpOrder = await createRazorpayOrder({
      amount: verified.verifiedTotal,
      receipt: orderNumber,
      notes: {
        orderNumber,
        type: "order",
      },
    });

    // Create pending order with verified amounts
    const newOrder = await Order.create({
      orderNumber,
      customer: customerId || undefined,
      customerSnapshot: { ...customer, phone: clean10 || cleanedPhone, buyerGstin: gstinValue },
      items: verified.verifiedItems,
      subtotal: verified.verifiedSubtotal,
      shipping: verified.verifiedShipping,
      discount: verified.verifiedDiscount,
      coupon: verified.verifiedCoupon,
      taxableAmount: verified.taxableAmount,
      gstRate: verified.gstRate, // 18%
      gstAmount: verified.gstAmount,
      tax: verified.gstAmount,
      buyerGstin: gstinValue,
      total: verified.verifiedTotal,
      currency: "INR",
      shippingAddress: {
        address: customer.address || shippingAddress.address || "",
        landmark: customer.landmark || shippingAddress.landmark || "",
        city: customer.city || shippingAddress.city || "",
        state: customer.state || shippingAddress.state || "",
        pincode: customer.pincode || shippingAddress.pincode || "",
      },
      status: "pending",
      paymentStatus: "pending",
      paymentProvider: "online",
      paymentReference: rzpOrder.orderId || txnid,
      trackingNumber: "",
    });

    const firstname = (customer.fullName || customer.name || "Customer")
      .trim()
      .split(" ")[0];
    const email = customer.email?.trim() || "orders@bhuwneshwarivastu.com";

    return res.json({
      success: true,
      provider: "razorpay",
      keyId: rzpOrder.keyId,
      orderId: rzpOrder.orderId,
      amount: rzpOrder.amount,
      currency: rzpOrder.currency,
      orderNumber,
      txnid,
      orderDatabaseId: newOrder._id,
      customer: {
        name: customer.fullName || customer.name || "Customer",
        email,
        phone: cleanedPhone,
      },
      verifiedSummary: {
        subtotal: verified.verifiedSubtotal,
        discount: verified.verifiedDiscount,
        coupon: verified.verifiedCoupon,
        taxableAmount: verified.taxableAmount,
        gstRate: verified.gstRate,
        gstAmount: verified.gstAmount,
        shipping: verified.verifiedShipping,
        total: verified.verifiedTotal,
      },
    });
  } catch (error) {
    console.error("initiateOrderPayment error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Unable to initiate order payment" });
  }
}

/**
 * Verify Razorpay payment for Product Order Checkout
 */
export async function verifyOrderPayment(req, res) {
  try {
    await connectDB();
    const data = req.body || {};
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      txnid,
      orderNumber,
    } = data;

    if (!txnid && !orderNumber && !razorpay_order_id) {
      return res.status(400).json({
        success: false,
        error: "Missing transaction ID or order number",
      });
    }

    const order = await Order.findOne({
      $or: [
        ...(orderNumber ? [{ orderNumber }] : []),
        ...(txnid ? [{ paymentReference: txnid }] : []),
        ...(razorpay_order_id ? [{ paymentReference: razorpay_order_id }] : []),
      ],
    });

    if (!order) {
      return res
        .status(404)
        .json({ success: false, error: "Order record not found" });
    }

    if (order.paymentStatus === "paid") {
      const redirectUrl =
        process.env.ORDER_SUCCESS_URL ||
        `${getFrontendUrl()}/orders?orderId=${order.orderNumber}&placed=true`;
      return res.json({
        success: true,
        message: "Order payment already verified",
        order,
        redirectUrl,
      });
    }

    const isValid = verifyRazorpaySignature({
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    });

    if (!isValid) {
      order.paymentStatus = "failed";
      await order.save();
      const redirectUrl = getPaymentFailureUrl({
        type: "order",
        status: "failed",
        orderId: order.orderNumber,
        error: "Payment verification failed",
      });
      return res
        .status(400)
        .json({ success: false, error: "Payment verification failed", redirectUrl });
    }

    order.paymentStatus = "paid";
    order.status = "confirmed";
    order.paidAmount = order.total;
    order.dueAmount = 0;
    order.paymentType = "full";
    order.paymentProvider = "online";
    order.paymentReference = razorpay_payment_id || razorpay_order_id || txnid;
    await order.save();

    if (order.coupon) {
      await Coupon.updateOne({ code: order.coupon }, { $inc: { usedCount: 1 } });
    }

    const redirectUrl =
      process.env.ORDER_SUCCESS_URL ||
      `${getFrontendUrl()}/orders?orderId=${order.orderNumber}&placed=true`;

    return res.json({
      success: true,
      message: "Payment successfully verified! Order confirmed.",
      order,
      redirectUrl,
    });
  } catch (error) {
    console.error("verifyOrderPayment error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Unable to verify order payment" });
  }
}

/**
 * Cash on Delivery (COD) order placement
 */
export async function createCodOrder(req, res) {
  try {
    await connectDB();
    const {
      items = [],
      customer = {},
      coupon = null,
      shippingAddress = {},
      buyerGstin = "",
    } = req.body;

    if (!items.length) {
      return res.status(400).json({
        success: false,
        error: "Cart is empty",
      });
    }

    // Backend Security Verification
    const verified = await verifyOrderCalculation({
      items,
      couponCode: coupon,
      customer,
    });

    if (verified.verifiedTotal <= 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid total calculation",
      });
    }

    const cleanedPhone = digitsOnly(customer.phone);
    const clean10 = cleanedPhone.slice(-10);
    const orderNumber = `BSV-${Date.now().toString().slice(-8)}`;

    const userId = req.user?.id || req.user?._id;
    let customerId = userId;
    if (!customerId && clean10) {
      const userDoc = await User.findOne({ phone: { $regex: new RegExp(clean10 + "$") } }).lean();
      if (userDoc) customerId = userDoc._id;
    }

    const gstinValue = String(buyerGstin || customer.buyerGstin || customer.gstin || "").trim();

    const newOrder = await Order.create({
      orderNumber,
      customer: customerId || undefined,
      customerSnapshot: { ...customer, phone: clean10 || cleanedPhone, buyerGstin: gstinValue },
      items: verified.verifiedItems,
      subtotal: verified.verifiedSubtotal,
      shipping: verified.verifiedShipping,
      discount: verified.verifiedDiscount,
      coupon: verified.verifiedCoupon,
      taxableAmount: verified.taxableAmount,
      gstRate: verified.gstRate, // 18%
      gstAmount: verified.gstAmount,
      tax: verified.gstAmount,
      buyerGstin: gstinValue,
      total: verified.verifiedTotal,
      currency: "INR",
      shippingAddress: {
        address: customer.address || shippingAddress.address || "",
        landmark: customer.landmark || shippingAddress.landmark || "",
        city: customer.city || shippingAddress.city || "",
        state: customer.state || shippingAddress.state || "",
        pincode: customer.pincode || shippingAddress.pincode || "",
      },
      status: "confirmed",
      paymentStatus: "pending",
      paymentProvider: "cod",
      paymentReference: "COD",
      trackingNumber: "",
    });

    if (verified.verifiedCoupon) {
      await Coupon.updateOne({ code: verified.verifiedCoupon }, { $inc: { usedCount: 1 } });
    }

    return res.status(201).json({
      success: true,
      message: "Order placed successfully (Cash on Delivery)",
      order: newOrder,
    });
  } catch (error) {
    console.error("createCodOrder error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Unable to place COD order" });
  }
}

export async function getAdminEnrollments(req, res) {
  try {
    await connectDB();
    const data = await Enrollment.find({}).sort({ createdAt: -1 }).lean();
    const normalized = data.map((e) => {
      const isPaid = e.paymentStatus === "paid";
      const tot = Number(e.amount || 0);
      const paid = e.paidAmount !== undefined ? Number(e.paidAmount) : (isPaid ? tot : 0);
      const due = e.dueAmount !== undefined ? Number(e.dueAmount) : Math.max(0, tot - paid);
      return {
        ...e,
        paidAmount: paid,
        dueAmount: due,
      };
    });
    return res.json({ success: true, data: normalized });
  } catch {
    return res.status(500).json({ success: false, error: "Unable to fetch enrollments" });
  }
}

export async function createAdminEnrollment(req, res) {
  try {
    const b = req.body || {};
    const { userName, userPhone, userEmail, courseTitle, courseSlug, amount, paidAmount, paymentMethod, whatsappLink, notes } = b;

    if (!userPhone?.trim() || !courseTitle?.trim()) {
      return res.status(400).json({ success: false, error: "Student phone number and course title are required" });
    }

    const cleanedPhone = userPhone.replace(/\D/g, "").slice(-10);
    const totalAmount = Number(amount || 0);
    const paid = Math.max(0, Number(paidAmount || 0));
    const due = Math.max(0, totalAmount - paid);
    const method = String(paymentMethod || "Cash").trim();

    let paymentStatus = "pending";
    let paymentType = "unpaid";
    if (paid >= totalAmount && totalAmount > 0) {
      paymentStatus = "paid";
      paymentType = "full";
    } else if (paid > 0) {
      paymentStatus = "partial";
      paymentType = "partial";
    }

    const enrollmentId = `BSV-ENR-${Math.floor(100000 + Math.random() * 900000)}`;

    const paymentHistory = [];
    if (paid > 0) {
      paymentHistory.push({
        amount: paid,
        method,
        date: new Date(),
        notes: notes || (due > 0 ? `Initial partial enrollment payment. Due: ₹${due}` : "Full payment"),
        reference: `MANUAL-${Date.now().toString().slice(-6)}`,
      });
    }

    const resolvedWhatsappLink = getWhatsappLinkForCourse(courseTitle, whatsappLink);

    await connectDB();
    const enrollment = await Enrollment.create({
      enrollmentId,
      userName: userName || "Student",
      userPhone: cleanedPhone,
      userEmail: userEmail || "",
      courseTitle,
      courseSlug: courseSlug || "",
      amount: totalAmount,
      paidAmount: paid,
      dueAmount: due,
      paymentType,
      paymentHistory,
      paymentStatus,
      paymentProvider: method,
      whatsappLink: resolvedWhatsappLink,
      status: "active",
    });

    return res.status(201).json({
      success: true,
      message: "Student enrolled successfully",
      data: enrollment,
    });
  } catch (err) {
    console.error("createAdminEnrollment error:", err);
    return res.status(500).json({ success: false, error: "Unable to enroll student" });
  }
}

export async function recordAdminEnrollmentPayment(req, res) {
  try {
    const { id } = req.params;
    const amount = Number(req.body.amount || 0);
    const method = String(req.body.method || "Cash").trim();
    const notes = String(req.body.notes || "").trim();
    const reference = String(req.body.reference || `REC-ENR-${Date.now().toString().slice(-6)}`);

    if (amount <= 0) {
      return res.status(400).json({ success: false, error: "Payment amount must be greater than 0" });
    }

    await connectDB();
    const enrollment = await Enrollment.findById(id);
    if (!enrollment) {
      return res.status(404).json({ success: false, error: "Enrollment not found" });
    }

    const currentPaid = Number(enrollment.paidAmount || (enrollment.paymentStatus === "paid" ? enrollment.amount : 0));
    const newPaid = currentPaid + amount;
    const newDue = Math.max(0, Number(enrollment.amount) - newPaid);

    enrollment.paidAmount = newPaid;
    enrollment.dueAmount = newDue;
    enrollment.paymentType = newDue === 0 ? "full" : "partial";
    enrollment.paymentStatus = newDue === 0 ? "paid" : "partial";

    if (!enrollment.paymentHistory) enrollment.paymentHistory = [];
    enrollment.paymentHistory.push({
      amount,
      method,
      date: new Date(),
      notes: notes || `Payment recorded. Remaining balance: ₹${newDue}`,
      reference,
    });

    await enrollment.save();

    return res.json({
      success: true,
      message: `Payment of ₹${amount} recorded successfully.`,
      data: enrollment,
    });
  } catch (err) {
    console.error("recordAdminEnrollmentPayment error:", err);
    return res.status(500).json({ success: false, error: "Unable to record payment" });
  }
}

/**
 * Unified General Payment Verification endpoint
 */
export async function verifyGeneralPayment(req, res) {
  try {
    await connectDB();
    const data = req.body || {};
    const {
      type,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      reference,
      orderNumber,
      enrollmentId,
      donationId,
    } = data;

    const isValid = verifyRazorpaySignature({
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    });

    if (!isValid) {
      return res.status(400).json({
        success: false,
        error: "Payment signature verification failed",
        redirectUrl: getPaymentFailureUrl({ type, error: "signature_invalid" }),
      });
    }

    // 1. Order
    if (type === "order" || orderNumber) {
      const ord = await Order.findOne({
        $or: [
          ...(orderNumber ? [{ orderNumber }] : []),
          ...(reference ? [{ orderNumber: reference }] : []),
          ...(razorpay_order_id ? [{ paymentReference: razorpay_order_id }] : []),
        ],
      });
      if (ord) {
        ord.paymentStatus = "paid";
        ord.status = "confirmed";
        ord.paidAmount = ord.total;
        ord.dueAmount = 0;
        ord.paymentType = "full";
        ord.paymentProvider = "online";
        ord.paymentReference = razorpay_payment_id;
        await ord.save();
        return res.json({
          success: true,
          redirectUrl: getPaymentSuccessUrl({
            type: "order",
            status: "success",
            orderId: ord.orderNumber,
            txnid: razorpay_payment_id,
          }),
        });
      }
    }

    // 2. Appointment
    if (type === "appointment" || String(reference || "").startsWith("BSV-APT")) {
      const apt = await Consultation.findOne({
        $or: [
          ...(reference ? [{ reference }] : []),
          ...(razorpay_order_id ? [{ paymentReference: razorpay_order_id }] : []),
        ],
      });
      if (apt) {
        apt.paymentStatus = "paid";
        apt.paymentProvider = "online";
        apt.paymentReference = razorpay_payment_id;
        apt.status = "pending";
        await apt.save();
        return res.json({
          success: true,
          redirectUrl: getPaymentSuccessUrl({
            type: "appointment",
            status: "success",
            reference: apt.reference,
            amount: apt.amount,
            service: apt.type,
            txnid: razorpay_payment_id,
          }),
        });
      }
    }

    // 3. Training
    if (type === "training" || enrollmentId || String(reference || "").startsWith("BSV-ENR")) {
      const enr = await Enrollment.findOne({
        $or: [
          ...(enrollmentId ? [{ enrollmentId }] : []),
          ...(reference ? [{ enrollmentId: reference }] : []),
          ...(razorpay_order_id ? [{ paymentReference: razorpay_order_id }] : []),
        ],
      });
      if (enr) {
        enr.paymentStatus = "paid";
        enr.paidAmount = enr.amount;
        enr.dueAmount = 0;
        enr.paymentType = "full";
        enr.paymentProvider = "online";
        enr.paymentReference = razorpay_payment_id;
        await enr.save();
        return res.json({
          success: true,
          redirectUrl: getPaymentSuccessUrl({
            type: "training",
            status: "success",
            enrollmentId: enr.enrollmentId,
            course: enr.courseTitle,
            txnid: razorpay_payment_id,
          }),
        });
      }
    }

    // 4. Donation
    if (type === "donation" || donationId || String(reference || "").startsWith("BSV-NGO")) {
      const don = await Donation.findOne({
        $or: [
          ...(donationId ? [{ donationId }] : []),
          ...(reference ? [{ donationId: reference }] : []),
          ...(razorpay_order_id ? [{ paymentReference: razorpay_order_id }] : []),
        ],
      });
      if (don) {
        don.paymentStatus = "paid";
        don.paymentProvider = "online";
        don.paymentReference = razorpay_payment_id;
        await don.save();
        return res.json({
          success: true,
          redirectUrl: getPaymentSuccessUrl({
            type: "donation",
            status: "success",
            donationId: don.donationId,
            amount: don.amount,
            txnid: razorpay_payment_id,
          }),
        });
      }
    }

    return res.json({
      success: true,
      redirectUrl: getPaymentSuccessUrl({ status: "success", txnid: razorpay_payment_id }),
    });
  } catch (err) {
    console.error("verifyGeneralPayment error:", err);
    return res.status(500).json({
      success: false,
      error: "Server error verifying payment",
      redirectUrl: getPaymentFailureUrl({ error: "server_error" }),
    });
  }
}

/**
 * Handle generic webhook / response
 */
export async function handlePaymentResponse(req, res) {
  try {
    await connectDB();
    const data = req.body || {};
    const { txnid, status, udf1, udf2 } = data;

    const isSuccess = (status === "success" || status === "captured");

    if (isSuccess) {
      return res.redirect(getPaymentSuccessUrl({ status: "success", txnid }));
    } else {
      return res.redirect(getPaymentFailureUrl({ status: "failed", txnid }));
    }
  } catch (error) {
    console.error("handlePaymentResponse error:", error);
    return res.redirect(getPaymentFailureUrl({ error: "server_error" }));
  }
}

export const handlePayUResponse = handlePaymentResponse;
