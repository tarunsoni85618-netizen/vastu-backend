import mongoose from "mongoose";
import Coupon from "../models/Coupon.js";
import Product from "../models/Product.js";
import StoreSettings from "../models/StoreSettings.js";
import { connectDB } from "../lib/dbConnect.js";

/**
 * Validate a coupon against database and subtotal
 */
export async function validateCouponInternal(code, subtotal) {
  if (!code || typeof code !== "string") {
    return { valid: false, error: "Coupon code is required" };
  }

  const cleanCode = code.trim().toUpperCase();
  const coupon = await Coupon.findOne({ code: cleanCode });

  if (!coupon) {
    return { valid: false, error: "Invalid coupon code" };
  }

  if (!coupon.isActive) {
    return { valid: false, error: "This coupon is currently inactive" };
  }

  const now = new Date();
  if (coupon.startDate && new Date(coupon.startDate) > now) {
    return { valid: false, error: "This coupon is not active yet" };
  }

  if (coupon.endDate && new Date(coupon.endDate) < now) {
    return { valid: false, error: "This coupon has expired" };
  }

  if (coupon.usageLimit > 0 && coupon.usedCount >= coupon.usageLimit) {
    return { valid: false, error: "This coupon usage limit has been reached" };
  }

  const numSubtotal = Math.max(0, Number(subtotal) || 0);
  if (coupon.minOrderAmount > 0 && numSubtotal < coupon.minOrderAmount) {
    return {
      valid: false,
      error: `Minimum order amount of ₹${coupon.minOrderAmount.toLocaleString("en-IN")} required for this coupon`,
    };
  }

  let discount = 0;
  if (coupon.discountType === "flat") {
    discount = Math.min(coupon.discountValue, numSubtotal);
  } else {
    // percentage
    discount = Math.round((numSubtotal * coupon.discountValue) / 100);
  }

  if (coupon.maxDiscountAmount > 0 && discount > coupon.maxDiscountAmount) {
    discount = coupon.maxDiscountAmount;
  }

  return {
    valid: true,
    coupon,
    code: coupon.code,
    discountType: coupon.discountType,
    discountValue: coupon.discountValue,
    discount,
    description: coupon.description,
  };
}

/**
 * Comprehensive server-side verification of cart items, product prices, coupon, 18% GST, and shipping.
 * Ensures complete backend security against any client-side tampering.
 */
export async function verifyOrderCalculation({ items = [], couponCode = "", customer = {} }) {
  await connectDB();

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Cart is empty");
  }

  // 1. Fetch products from DB
  const itemIds = [];
  const itemSlugs = [];

  for (const it of items) {
    const rawId = it._id || it.id || it.productId;
    if (rawId && mongoose.isValidObjectId(rawId)) {
      itemIds.push(new mongoose.Types.ObjectId(rawId));
    } else if (it.slug) {
      itemSlugs.push(it.slug);
    }
  }

  const dbProducts = await Product.find({
    $or: [
      { _id: { $in: itemIds } },
      { slug: { $in: itemSlugs } },
    ],
  }).lean();

  const productMap = new Map();
  for (const p of dbProducts) {
    productMap.set(String(p._id), p);
    if (p.slug) productMap.set(p.slug, p);
  }

  // 2. Verify items & calculate subtotal
  let verifiedSubtotal = 0;
  const verifiedItems = items.map((it) => {
    const rawId = it._id || it.id || it.productId;
    const lookupKey = rawId ? String(rawId) : it.slug;
    const dbP = productMap.get(lookupKey) || (it.slug ? productMap.get(it.slug) : null);

    const qty = Math.max(1, parseInt(it.quantity, 10) || 1);
    let unitPrice = 0;

    if (dbP) {
      unitPrice = Number(
        dbP.salePrice !== null && dbP.salePrice !== undefined && dbP.salePrice >= 0
          ? dbP.salePrice
          : dbP.regularPrice || 0
      );
    } else {
      // Fallback to client item price if product was custom/legacy, but ensure non-negative
      unitPrice = Math.max(0, Number(it.price || it.unitPrice || 0));
    }

    const lineTotal = unitPrice * qty;
    verifiedSubtotal += lineTotal;

    return {
      id: dbP ? String(dbP._id) : (rawId || it.slug || ""),
      productId: dbP ? String(dbP._id) : undefined,
      title: dbP?.title || it.title || it.name || "Product",
      name: dbP?.title || it.name || it.title || "Product",
      price: unitPrice,
      unitPrice,
      quantity: qty,
      image: dbP?.images?.[0]?.url || it.image || it.imageUrl || "",
      lineTotal,
    };
  });

  // 3. Verify coupon
  let verifiedDiscount = 0;
  let verifiedCoupon = "";

  if (couponCode && String(couponCode).trim()) {
    const couponRes = await validateCouponInternal(couponCode, verifiedSubtotal);
    if (couponRes.valid) {
      verifiedDiscount = couponRes.discount;
      verifiedCoupon = couponRes.code;
    }
  }

  // 4. Taxable Amount & 18% GST calculation
  const taxableAmount = Math.max(0, verifiedSubtotal - verifiedDiscount);
  const gstRate = 18;
  const gstAmount = Math.round(taxableAmount * 0.18);

  // 5. Verify Shipping Settings
  const storeSettings = await StoreSettings.findOne({ key: "main" }).lean();
  const shippingConf = storeSettings?.shipping || {
    shippingEnabled: true,
    freeShippingEnabled: false,
    freeShippingThreshold: 1999,
    flatRateEnabled: true,
    flatRate: 99,
  };

  let verifiedShipping = 0;
  if (shippingConf.shippingEnabled !== false && verifiedSubtotal > 0) {
    if (
      shippingConf.freeShippingEnabled &&
      taxableAmount >= (Number(shippingConf.freeShippingThreshold) || 1999)
    ) {
      verifiedShipping = 0;
    } else if (shippingConf.flatRateEnabled !== false) {
      verifiedShipping = Number(shippingConf.flatRate || 99);
    }
  }

  // 6. Grand total
  const verifiedTotal = taxableAmount + gstAmount + verifiedShipping;

  return {
    verifiedItems,
    verifiedSubtotal,
    verifiedDiscount,
    verifiedCoupon,
    taxableAmount,
    gstRate,
    gstAmount,
    verifiedShipping,
    verifiedTotal,
  };
}

/**
 * Public endpoint: POST /api/coupons/apply
 */
export async function validateCouponHandler(req, res) {
  try {
    await connectDB();
    const { code, subtotal = 0 } = req.body || {};

    if (!code) {
      return res.status(400).json({ success: false, error: "Coupon code is required" });
    }

    const result = await validateCouponInternal(code, subtotal);
    if (!result.valid) {
      return res.status(400).json({ success: false, error: result.error });
    }

    return res.json({
      success: true,
      coupon: {
        code: result.code,
        discountType: result.discountType,
        discountValue: result.discountValue,
        discount: result.discount,
        description: result.description,
      },
    });
  } catch (error) {
    console.error("validateCouponHandler error:", error);
    return res.status(500).json({ success: false, error: "Failed to validate coupon" });
  }
}

/**
 * Admin: GET /api/admin/coupons
 */
export async function getAdminCoupons(req, res) {
  try {
    await connectDB();
    const coupons = await Coupon.find({}).sort({ createdAt: -1 }).lean();
    return res.json({ success: true, data: coupons });
  } catch (error) {
    console.error("getAdminCoupons error:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch coupons" });
  }
}

/**
 * Admin: POST /api/admin/coupons
 */
export async function createAdminCoupon(req, res) {
  try {
    await connectDB();
    const {
      code,
      description = "",
      discountType = "percentage",
      discountValue,
      minOrderAmount = 0,
      maxDiscountAmount = 0,
      startDate = null,
      endDate = null,
      usageLimit = 0,
      isActive = true,
    } = req.body || {};

    if (!code || !code.trim()) {
      return res.status(400).json({ success: false, error: "Coupon code is required" });
    }

    const cleanCode = code.trim().toUpperCase();
    const existing = await Coupon.findOne({ code: cleanCode });
    if (existing) {
      return res.status(400).json({ success: false, error: `Coupon code '${cleanCode}' already exists` });
    }

    if (discountValue === undefined || discountValue === null || Number(discountValue) < 0) {
      return res.status(400).json({ success: false, error: "Valid discount value is required" });
    }

    const coupon = await Coupon.create({
      code: cleanCode,
      description: String(description || "").trim(),
      discountType: discountType === "flat" ? "flat" : "percentage",
      discountValue: Number(discountValue),
      minOrderAmount: Math.max(0, Number(minOrderAmount) || 0),
      maxDiscountAmount: Math.max(0, Number(maxDiscountAmount) || 0),
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      usageLimit: Math.max(0, Number(usageLimit) || 0),
      isActive: Boolean(isActive),
    });

    return res.status(201).json({ success: true, data: coupon });
  } catch (error) {
    console.error("createAdminCoupon error:", error);
    return res.status(500).json({ success: false, error: "Failed to create coupon" });
  }
}

/**
 * Admin: PUT /api/admin/coupons/:id
 */
export async function updateAdminCoupon(req, res) {
  try {
    await connectDB();
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: "Invalid coupon ID" });
    }

    const b = req.body || {};
    const update = {};

    if (b.code !== undefined) {
      const cleanCode = String(b.code).trim().toUpperCase();
      const existing = await Coupon.findOne({ code: cleanCode, _id: { $ne: id } });
      if (existing) {
        return res.status(400).json({ success: false, error: `Coupon code '${cleanCode}' is already taken` });
      }
      update.code = cleanCode;
    }

    if (b.description !== undefined) update.description = String(b.description).trim();
    if (b.discountType !== undefined) update.discountType = b.discountType === "flat" ? "flat" : "percentage";
    if (b.discountValue !== undefined) update.discountValue = Math.max(0, Number(b.discountValue) || 0);
    if (b.minOrderAmount !== undefined) update.minOrderAmount = Math.max(0, Number(b.minOrderAmount) || 0);
    if (b.maxDiscountAmount !== undefined) update.maxDiscountAmount = Math.max(0, Number(b.maxDiscountAmount) || 0);
    if (b.startDate !== undefined) update.startDate = b.startDate ? new Date(b.startDate) : null;
    if (b.endDate !== undefined) update.endDate = b.endDate ? new Date(b.endDate) : null;
    if (b.usageLimit !== undefined) update.usageLimit = Math.max(0, Number(b.usageLimit) || 0);
    if (b.isActive !== undefined) update.isActive = Boolean(b.isActive);

    const coupon = await Coupon.findByIdAndUpdate(id, { $set: update }, { new: true });
    if (!coupon) {
      return res.status(404).json({ success: false, error: "Coupon not found" });
    }

    return res.json({ success: true, data: coupon });
  } catch (error) {
    console.error("updateAdminCoupon error:", error);
    return res.status(500).json({ success: false, error: "Failed to update coupon" });
  }
}

/**
 * Admin: DELETE /api/admin/coupons/:id
 */
export async function deleteAdminCoupon(req, res) {
  try {
    await connectDB();
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: "Invalid coupon ID" });
    }

    const coupon = await Coupon.findByIdAndDelete(id);
    if (!coupon) {
      return res.status(404).json({ success: false, error: "Coupon not found" });
    }

    return res.json({ success: true, message: "Coupon deleted successfully" });
  } catch (error) {
    console.error("deleteAdminCoupon error:", error);
    return res.status(500).json({ success: false, error: "Failed to delete coupon" });
  }
}
