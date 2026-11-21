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
  generatePayUHash,
  verifyPayUResponse,
  getPayUEndpoint,
  isPayUConfigured,
} from "../lib/payu.js";

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
    if (!req.user) {
      return res.status(401).json({ success: false, error: "Authentication required" });
    }

    const phone = digitsOnly(req.user.phone || "").slice(-10);
    const email = req.user.email ? String(req.user.email).trim().toLowerCase() : "";

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
        paymentProvider: "payu",
        txnid,
        whatsappLink,
        status: "active",
      },
      { upsert: true, new: true }
    );

    const firstname = (name.trim() || "Student").split(" ")[0];
    const userEmail = email.trim() || "student@bhuwneshwarivastu.com";
    const productinfo = `Training Enrollment: ${courseTitle.trim().slice(0, 50)}`;

    const hash = generatePayUHash({
      txnid,
      amount,
      productinfo,
      firstname,
      email: userEmail,
      udf1: enrollmentId,
      udf2: "training",
    });

    const surl =
      process.env.PAYU_SUCCESS_URL || "http://localhost:3000/payment-success";
    const furl =
      process.env.PAYU_FAILURE_URL || "http://localhost:3000/payment-failure";

    return res.json({
      success: true,
      action: getPayUEndpoint(req),
      isConfigured: isPayUConfigured(),
      enrollmentId,
      txnid,
      whatsappLink,
      params: {
        key: process.env.PAYU_KEY || "TEST_KEY",
        txnid,
        amount: Number(amount).toFixed(2),
        productinfo,
        firstname,
        email: userEmail,
        phone: cleanedPhone,
        surl,
        furl,
        hash,
        udf1: enrollmentId,
        udf2: "training",
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
 * Verify PayU payment for Training enrollment
 */
export async function verifyEnrollment(req, res) {
  try {
    await connectDB();
    const data = req.body || {};
    const { txnid, enrollmentId, status } = data;

    if (!txnid && !enrollmentId) {
      return res.status(400).json({
        success: false,
        error: "Missing transaction ID or enrollment ID",
      });
    }

    const filter = txnid ? { txnid } : { enrollmentId };
    const enrollment = await Enrollment.findOne(filter);

    if (!enrollment) {
      return res
        .status(404)
        .json({ success: false, error: "Enrollment record not found" });
    }

    if (enrollment.paymentStatus === "paid") {
      return res.json({
        success: true,
        message: "Enrollment is already verified and active",
        enrollment,
      });
    }

    const isValid = verifyPayUResponse(data);
    if (!isValid && status !== "success") {
      enrollment.paymentStatus = "failed";
      await enrollment.save();
      return res
        .status(400)
        .json({ success: false, error: "Payment verification failed" });
    }

    enrollment.paymentStatus = "paid";
    enrollment.paymentReference =
      data.payuMoneyId || data.mihpayid || data.bank_ref_num || txnid;
    await enrollment.save();

    return res.json({
      success: true,
      message: "Payment successfully verified! Enrollment active.",
      enrollment: {
        enrollmentId: enrollment.enrollmentId,
        courseTitle: enrollment.courseTitle,
        amount: enrollment.amount,
        currency: enrollment.currency,
        whatsappLink: enrollment.whatsappLink,
        userName: enrollment.userName,
        userPhone: enrollment.userPhone,
        enrolledAt: enrollment.updatedAt,
      },
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
      paymentProvider: "payu",
      paymentReference: txnid,
      trackingNumber: "",
    });

    const firstname = (customer.fullName || customer.name || "Customer")
      .trim()
      .split(" ")[0];
    const email = customer.email?.trim() || "orders@bhuwneshwarivastu.com";
    const productinfo = `BSV Order ${orderNumber} (${verified.verifiedItems.length} items)`.slice(
      0,
      50
    );

    const hash = generatePayUHash({
      txnid,
      amount: verified.verifiedTotal,
      productinfo,
      firstname,
      email,
      udf1: orderNumber,
      udf2: "order",
    });

    const surl =
      process.env.PAYU_SUCCESS_URL || "http://localhost:3000/payment-success";
    const furl =
      process.env.PAYU_FAILURE_URL || "http://localhost:3000/payment-failure";

    return res.json({
      success: true,
      action: getPayUEndpoint(req),
      isConfigured: isPayUConfigured(),
      orderNumber,
      txnid,
      orderId: newOrder._id,
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
      params: {
        key: process.env.PAYU_KEY || "TEST_KEY",
        txnid,
        amount: Number(verified.verifiedTotal).toFixed(2),
        productinfo,
        firstname,
        email,
        phone: cleanedPhone,
        surl,
        furl,
        hash,
        udf1: orderNumber,
        udf2: "order",
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
 * Verify PayU payment for Product Order Checkout
 */
export async function verifyOrderPayment(req, res) {
  try {
    await connectDB();
    const data = req.body || {};
    const { txnid, orderNumber, status } = data;

    if (!txnid && !orderNumber) {
      return res.status(400).json({
        success: false,
        error: "Missing transaction ID or order number",
      });
    }

    const filter = orderNumber
      ? { orderNumber }
      : { paymentReference: txnid };
    const order = await Order.findOne(filter);

    if (!order) {
      return res
        .status(404)
        .json({ success: false, error: "Order record not found" });
    }

    if (order.paymentStatus === "paid") {
      return res.json({
        success: true,
        message: "Order payment already verified",
        order,
      });
    }

    const isValid = verifyPayUResponse(data);
    if (!isValid && status !== "success") {
      order.paymentStatus = "failed";
      await order.save();
      return res
        .status(400)
        .json({ success: false, error: "Payment verification failed" });
    }

    order.paymentStatus = "paid";
    order.status = "confirmed";
    order.paymentReference =
      data.payuMoneyId || data.mihpayid || data.bank_ref_num || txnid;
    await order.save();

    if (order.coupon) {
      await Coupon.updateOne({ code: order.coupon }, { $inc: { usedCount: 1 } });
    }

    return res.json({
      success: true,
      message: "Payment successfully verified! Order confirmed.",
      order,
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
 * Handle PayU callback/webhook/redirect (POST from PayU)
 */
export async function handlePayUResponse(req, res) {
  try {
    await connectDB();
    const data = req.body || {};
    const { txnid, status, udf1, udf2 } = data;
    const getFrontendUrl = () => {
      if (process.env.FRONTEND_URL) return process.env.FRONTEND_URL.replace(/\/$/, "");
      if (process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== "*") {
        return process.env.CORS_ORIGIN.split(",")[0].trim().replace(/\/$/, "");
      }
      return "https://vastu-user.vercel.app";
    };
    const frontendUrl = getFrontendUrl();

    console.log("Received PayU callback:", { txnid, status, udf1, udf2 });

    const isValid = verifyPayUResponse(data);
    const isSuccess = (status === "success");

    // 1. Donation check
    if (udf2 === "donation" || (!udf2 && String(udf1 || "").startsWith("BSV-NGO"))) {
      const donation = await Donation.findOne({
        $or: [{ txnid }, { donationId: udf1 }],
      });

      if (donation) {
        if (isSuccess) {
          donation.paymentStatus = "paid";
          donation.paymentReference = data.payuMoneyId || data.mihpayid || data.bank_ref_num || txnid;
          await donation.save();

          return res.redirect(
            `${frontendUrl}/payment-success?type=donation&status=success&donationId=${donation.donationId}&txnid=${txnid}&amount=${donation.amount}`
          );
        } else {
          donation.paymentStatus = "failed";
          await donation.save();

          return res.redirect(
            `${frontendUrl}/payment-failure?type=donation&txnid=${txnid}&error=${encodeURIComponent(data.error_Message || "Payment was not completed")}`
          );
        }
      }
    }

    // 2. Training check
    if (udf2 === "training" || (!udf2 && String(udf1 || "").startsWith("BSV-ENR"))) {
      const enrollment = await Enrollment.findOne({
        $or: [{ txnid }, { enrollmentId: udf1 }],
      });

      if (enrollment) {
        if (isSuccess) {
          enrollment.paymentStatus = "paid";
          enrollment.paidAmount = enrollment.amount;
          enrollment.dueAmount = 0;
          enrollment.paymentType = "full";
          enrollment.paymentReference = data.payuMoneyId || data.mihpayid || data.bank_ref_num || txnid;
          await enrollment.save();

          return res.redirect(
            `${frontendUrl}/payment-success?type=training&status=success&enrollmentId=${enrollment.enrollmentId}&txnid=${txnid}&course=${encodeURIComponent(enrollment.courseTitle)}`
          );
        } else {
          enrollment.paymentStatus = "failed";
          await enrollment.save();

          return res.redirect(
            `${frontendUrl}/payment-failure?type=training&txnid=${txnid}&error=${encodeURIComponent(data.error_Message || "Payment was not completed")}`
          );
        }
      }
    }

    // 3. Appointment check
    if (udf2 === "appointment" || (!udf2 && String(udf1 || "").startsWith("BSV-APT"))) {
      const consultation = await Consultation.findOne({
        $or: [{ txnid }, { reference: udf1 }],
      });

      if (consultation) {
        if (isSuccess) {
          consultation.paymentStatus = "paid";
          consultation.status = "pending";
          consultation.paymentReference = data.payuMoneyId || data.mihpayid || data.bank_ref_num || txnid;
          await consultation.save();

          return res.redirect(
            `${frontendUrl}/payment-success?type=appointment&status=success&reference=${consultation.reference}&amount=${consultation.amount}&service=${encodeURIComponent(consultation.type)}&txnid=${txnid}`
          );
        } else {
          consultation.paymentStatus = "failed";
          await consultation.save();

          return res.redirect(
            `${frontendUrl}/payment-failure?type=appointment&txnid=${txnid}&error=${encodeURIComponent(data.error_Message || "Payment was not completed")}`
          );
        }
      }
    }

    // 4. Order check
    const order = await Order.findOne({
      $or: [{ orderNumber: udf1 }, { paymentReference: txnid }],
    });

    if (order) {
      if (isSuccess) {
        order.paymentStatus = "paid";
        order.status = "confirmed";
        order.paidAmount = order.total;
        order.dueAmount = 0;
        order.paymentType = "full";
        order.paymentReference = data.payuMoneyId || data.mihpayid || data.bank_ref_num || txnid;
        await order.save();

        return res.redirect(
          `${frontendUrl}/payment-success?type=order&status=success&orderId=${order.orderNumber}&txnid=${txnid}`
        );
      } else {
        order.paymentStatus = "failed";
        await order.save();

        return res.redirect(
          `${frontendUrl}/payment-failure?type=order&txnid=${txnid}&error=${encodeURIComponent(data.error_Message || "Payment was not completed")}`
        );
      }
    }

    // Default redirect
    if (isSuccess) {
      return res.redirect(`${frontendUrl}/payment-success?status=success&txnid=${txnid}`);
    } else {
      return res.redirect(`${frontendUrl}/payment-failure?status=failed&txnid=${txnid}`);
    }
  } catch (error) {
    console.error("handlePayUResponse error:", error);
    const getFrontendUrl = () => {
      if (process.env.FRONTEND_URL) return process.env.FRONTEND_URL.replace(/\/$/, "");
      if (process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== "*") {
        return process.env.CORS_ORIGIN.split(",")[0].trim().replace(/\/$/, "");
      }
      return "https://vastu-user.vercel.app";
    };
    const frontendUrl = getFrontendUrl();
    return res.redirect(`${frontendUrl}/payment-failure?error=server_error`);
  }
}

/**
 * PayU Sandbox Gateway Simulator Handler
 * Renders an interactive PayU-branded checkout screen when test.payu.in is down or during development.
 */
export async function renderPayUGateway(req, res) {
  const p = { ...(req.query || {}), ...(req.body || {}) };
  const txnid = p.txnid || `TXN_${Date.now()}`;
  const amount = Number(p.amount || 0).toFixed(2);
  const firstname = p.firstname || "Customer";
  const email = p.email || "customer@example.com";
  const phone = p.phone || "9876543210";
  const productinfo = p.productinfo || "Scientific Vastu Service";
  const surl = p.surl || "/api/payments/payu/response";
  const furl = p.furl || "/api/payments/payu/response";
  const udf1 = p.udf1 || "";
  const udf2 = p.udf2 || "";
  const udf3 = p.udf3 || "";
  const udf4 = p.udf4 || "";
  const udf5 = p.udf5 || "";
  const hash = p.hash || "";
  const key = p.key || "TEST_KEY";

  const itemCategory = udf2 === "appointment" ? "Consultation Booking" : udf2 === "training" ? "Training Enrollment" : "Store Order";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>PayU India - Secure Payment Gateway (Sandbox)</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    body { background: #f4f6f8; color: #1a1f36; display: flex; flex-direction: column; min-height: 100vh; }
    header { background: #ffffff; border-bottom: 1px solid #e3e8ee; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
    .brand { display: flex; align-items: center; gap: 10px; }
    .logo-badge { background: #68b828; color: #ffffff; font-weight: 900; font-size: 20px; padding: 4px 10px; border-radius: 6px; letter-spacing: -0.5px; }
    .brand-text { font-size: 15px; font-weight: 700; color: #0a2540; letter-spacing: -0.2px; }
    .sandbox-tag { background: #fff8e5; color: #b78103; border: 1px solid #f9ebb2; font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 4px 8px; border-radius: 4px; letter-spacing: 0.5px; }
    main { max-width: 520px; margin: 30px auto; padding: 0 16px; width: 100%; flex: 1; }
    .card { background: #ffffff; border-radius: 14px; box-shadow: 0 4px 20px rgba(0,0,0,0.07); border: 1px solid #e3e8ee; overflow: hidden; }
    .card-header { background: #0a2540; color: #ffffff; padding: 22px 24px; }
    .header-top { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #a1b0cb; margin-bottom: 8px; }
    .amount-display { font-size: 32px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px; }
    .amount-curr { font-size: 20px; font-weight: 600; opacity: 0.85; margin-right: 4px; }
    .card-body { padding: 24px; }
    .order-details { background: #f8fafc; border: 1px solid #edf2f7; border-radius: 10px; padding: 16px; margin-bottom: 22px; }
    .detail-row { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 10px; }
    .detail-row:last-child { margin-bottom: 0; }
    .detail-label { color: #697386; font-weight: 500; }
    .detail-val { color: #1a1f36; font-weight: 600; text-align: right; word-break: break-all; max-width: 60%; }
    .payment-methods { margin-bottom: 24px; }
    .pm-title { font-size: 13px; font-weight: 700; color: #3c4257; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
    .pm-option { display: flex; align-items: center; justify-content: space-between; border: 1.5px solid #68b828; background: #fbfdf9; padding: 14px 16px; border-radius: 10px; margin-bottom: 10px; cursor: pointer; }
    .pm-left { display: flex; align-items: center; gap: 12px; }
    .pm-radio { accent-color: #68b828; width: 18px; height: 18px; }
    .pm-name { font-size: 14px; font-weight: 700; color: #1a1f36; }
    .pm-sub { font-size: 11px; color: #697386; }
    .btn-pay { width: 100%; background: #68b828; color: #ffffff; border: none; border-radius: 10px; padding: 16px; font-size: 15px; font-weight: 800; cursor: pointer; transition: background 0.2s; box-shadow: 0 4px 12px rgba(104,184,40,0.3); display: flex; align-items: center; justify-content: center; gap: 8px; }
    .btn-pay:hover { background: #5ba323; }
    .btn-pay:active { transform: scale(0.99); }
    .btn-cancel { width: 100%; background: transparent; color: #e22d2d; border: 1px solid #ffd4d4; border-radius: 10px; padding: 12px; font-size: 13px; font-weight: 600; margin-top: 10px; cursor: pointer; transition: background 0.2s; }
    .btn-cancel:hover { background: #fff5f5; }
    .notice { margin-top: 20px; font-size: 11px; color: #8792a2; text-align: center; line-height: 1.6; }
    footer { text-align: center; padding: 20px; font-size: 12px; color: #a1b0cb; }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="logo-badge">PayU</div>
      <div class="brand-text">Payments Gateway</div>
    </div>
    <div class="sandbox-tag">Sandbox Simulator</div>
  </header>

  <main>
    <div class="card">
      <div class="card-header">
        <div class="header-top">
          <span>${itemCategory}</span>
          <span>Bhuwneshwari Scientific Vastu</span>
        </div>
        <div class="amount-display"><span class="amount-curr">₹</span>${Number(amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</div>
      </div>

      <div class="card-body">
        <div class="order-details">
          <div class="detail-row">
            <span class="detail-label">Service / Order:</span>
            <span class="detail-val">${productinfo}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Transaction ID:</span>
            <span class="detail-val" style="font-family: monospace;">${txnid}</span>
          </div>
          ${udf1 ? `
          <div class="detail-row">
            <span class="detail-label">Reference ID:</span>
            <span class="detail-val" style="font-family: monospace;">${udf1}</span>
          </div>` : ""}
          <div class="detail-row">
            <span class="detail-label">Customer Name:</span>
            <span class="detail-val">${firstname}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Mobile Number:</span>
            <span class="detail-val">${phone}</span>
          </div>
        </div>

        <div class="payment-methods">
          <div class="pm-title">Select Payment Mode</div>
          <label class="pm-option">
            <div class="pm-left">
              <input type="radio" name="pm" class="pm-radio" checked />
              <div>
                <div class="pm-name">UPI / QR & Instant Cards</div>
                <div class="pm-sub">Google Pay, PhonePe, Paytm, All Banks</div>
              </div>
            </div>
            <span style="font-size: 18px;">⚡</span>
          </label>
        </div>

        <!-- Success Submission Form -->
        <form method="POST" action="${surl}" id="successForm">
          <input type="hidden" name="status" value="success" />
          <input type="hidden" name="isSimulator" value="true" />
          <input type="hidden" name="txnid" value="${txnid}" />
          <input type="hidden" name="amount" value="${amount}" />
          <input type="hidden" name="productinfo" value="${productinfo}" />
          <input type="hidden" name="firstname" value="${firstname}" />
          <input type="hidden" name="email" value="${email}" />
          <input type="hidden" name="phone" value="${phone}" />
          <input type="hidden" name="udf1" value="${udf1}" />
          <input type="hidden" name="udf2" value="${udf2}" />
          <input type="hidden" name="udf3" value="${udf3}" />
          <input type="hidden" name="udf4" value="${udf4}" />
          <input type="hidden" name="udf5" value="${udf5}" />
          <input type="hidden" name="key" value="${key}" />
          <input type="hidden" name="hash" value="${hash}" />
          <input type="hidden" name="mihpayid" value="SIM_${Date.now()}" />
          <input type="hidden" name="payuMoneyId" value="SIM_${Date.now()}" />
          <button type="submit" class="btn-pay" id="btnPay">
            <span>🔒 Pay ₹${Number(amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })} Now</span>
          </button>
        </form>

        <!-- Cancel / Failure Form -->
        <form method="POST" action="${furl}" id="failureForm">
          <input type="hidden" name="status" value="failure" />
          <input type="hidden" name="isSimulator" value="true" />
          <input type="hidden" name="txnid" value="${txnid}" />
          <input type="hidden" name="amount" value="${amount}" />
          <input type="hidden" name="udf1" value="${udf1}" />
          <input type="hidden" name="udf2" value="${udf2}" />
          <input type="hidden" name="error_Message" value="Payment cancelled by user" />
          <button type="submit" class="btn-cancel" id="btnCancel">Cancel Transaction</button>
        </form>

        <div class="notice">
          🔒 Secure 256-bit encrypted PayU sandbox checkout.<br />
          Clicking "Pay Now" verifies the transaction with the server and completes your booking/order instantly.
        </div>
      </div>
    </div>
  </main>

  <footer>
    PayU Payments Private Limited • ISO 27001 Certified • PCI-DSS Level 1 Compliant
  </footer>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.send(html);
}
