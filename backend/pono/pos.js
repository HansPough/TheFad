import * as db from '../../db.js';
import { flash } from '../../flash.js';
import { renderPage } from '../../render.js';
import { loginRequired } from '../shared/auth.js';
import { toInt } from '../../utils.js';

function getCart(req) {
  if (!req.session.cart) req.session.cart = {};
  return req.session.cart;
}

// We must format the cart exactly how pos.html expects it:
// l.product.display_name, l.product.current_price, l.qty, l.line_total
function cartLines(products, cart) {
  const byId = new Map();
  for (const p of products) byId.set(String(p.product_id), p);
  
  return Object.entries(cart).map(([pid, qty]) => {
    const p = byId.get(pid) || { 
        product_id: pid, 
        display_name: `Product #${pid}`, 
        current_price: 0, 
        current_stock: 0 
    };
    return {
      product: p,
      qty: qty,
      line_total: Number(p.current_price ?? 0) * qty,
      short: qty > Number(p.current_stock ?? 0)
    };
  });
}

async function loadProducts(q, categoryId) {
  return db.callFunction('fn_list_products', q || null, categoryId, false);
}

function sortByStock(products) {
  return products.slice().sort((a, b) => {
    const oa = Number(a.current_stock ?? 0) <= 0 ? 1 : 0;
    const ob = Number(b.current_stock ?? 0) <= 0 ? 1 : 0;
    return oa - ob;
  });
}

export default function register(router) {
    router.get('/pos', 'pos.index', loginRequired, async (req, res) => {
    const q = String(req.query.q || '').trim();
    const categoryId = req.query.category ? toInt(req.query.category, null) : null;
    
    let products = [];
    let categories = [];
    try {
      products = await loadProducts(q, categoryId);
      // Fetch the categories from the database!
      categories = await db.callFunction('fn_list_categories');
    } catch (error) {
      flash(req, 'error', error.message);
    }
    
    const cart = getCart(req);
    const lines = cartLines(products, cart);
    const total = lines.reduce((s, l) => s + l.line_total, 0);

    return renderPage(req, res, 'pos.html', {
      products: sortByStock(products),
      lines: lines,
      total: total,
      q,
      category: categoryId,
      categories: categories // <-- Pass the real categories here
    });
  });

  router.post('/pos/cart/add', 'pos.add', loginRequired, async (req, res) => {
    const productId = toInt(req.body.product_id, null);
    const qty = toInt(req.body.quantity, 1);
    
    if (!productId || qty < 1) {
      flash(req, 'error', 'Enter a valid product and quantity.');
      return res.redirect('/pos');
    }
    
    let products = [];
    try {
      products = await loadProducts(null, null);
    } catch (error) {
      flash(req, 'error', error.message);
      return res.redirect('/pos');
    }
    
    const product = products.find((p) => Number(p.product_id) === productId);
    if (!product) {
      flash(req, 'error', `Product #${productId} not found.`);
      return res.redirect('/pos');
    }
    
    // fixed: database column is current_stock
    const stock = Number(product.current_stock ?? 0);
    if (stock <= 0) {
      flash(req, 'error', `${product.display_name || product.product_name} is out of stock.`);
      return res.redirect('/pos');
    }
    
    const cart = getCart(req);
    const key = String(productId);
    const wanted = (cart[key] || 0) + qty;
    cart[key] = Math.min(wanted, stock);
    
    if (cart[key] < wanted) {
      flash(req, 'info', `Only ${stock} in stock. Cart capped at ${stock}.`);
    } else {
      flash(req, 'success', 'Added to cart.');
    }
    return res.redirect('/pos');
  });

      // DB: fn_list_products — keep the cart quantity within stock
  router.post('/pos/cart/update', 'pos.update', loginRequired, async (req, res) => {
    const productId = Number(req.body.product_id);
    const qtyStr = req.body.quantity;
    const deltaStr = req.body.delta;

    if (!productId || isNaN(productId)) {
      flash(req, 'error', 'Invalid product.');
      return res.redirect('/pos');
    }

    const cart = getCart(req);
    const key = String(productId);

    let newQty = 0;
    // Check if the user clicked the + or - button (which sends 'delta')
    if (deltaStr !== undefined) {
      newQty = (cart[key] || 0) + Number(deltaStr);
    } 
    // Otherwise, check if they clicked the 'x' button (which sends 'quantity' = 0)
    else if (qtyStr !== undefined) {
      newQty = Number(qtyStr);
    }

    // If quantity drops to 0 or below, remove item
    if (isNaN(newQty) || newQty <= 0) {
      delete cart[key];
      flash(req, 'success', 'Item removed from cart.');
      return res.redirect('/pos');
    }

    let products = [];
    try {
      products = await loadProducts(null, null);
    } catch (error) {
      flash(req, 'error', error.message);
      return res.redirect('/pos');
    }

    const product = products.find((p) => Number(p.product_id) === productId);
    if (!product) {
      flash(req, 'error', `Product #${productId} not found.`);
      return res.redirect('/pos');
    }

    const stock = Number(product.current_stock || 0);
    cart[key] = Math.min(newQty, stock);

    if (cart[key] < newQty) {
      flash(req, 'info', `Only ${stock} in stock. Cart capped at ${stock}.`);
    }
    return res.redirect('/pos');
  });

  router.post('/pos/cart/clear', 'pos.clear', loginRequired, (req, res) => {
    req.session.cart = {};
    flash(req, 'success', 'Cart cleared.');
    return res.redirect('/pos');
  });

  router.post('/pos/checkout', 'pos.checkout', loginRequired, async (req, res) => {
    const cart = getCart(req);
    const items = Object.entries(cart).map(([pid, quantity]) => ({
      product_id: Number(pid),
      quantity,
    }));
    if (!items.length) {
      flash(req, 'error', 'The cart is empty. Add products from the list.');
      return res.redirect('/pos');
    }

    let fulfillmentType = String(req.body.fulfillment_type || 'Walk-in');

    if (fulfillmentType === 'Online') fulfillmentType = 'Delivery'; 

    const paymentMethod = String(req.body.payment_method || 'Cash');
    const customerName = String(req.body.customer_name || '').trim() || null;
    const customerContact = String(req.body.customer_contact || '').trim() || null;
    const deliveryAddress = String(req.body.delivery_address || '').trim() || null;

    try {
      const result = await db.callProcedure(
        'sp_create_sale',
        req.session.user_id,
        fulfillmentType,
        paymentMethod,
        customerName,
        customerContact,
        deliveryAddress,
        JSON.stringify(items),
        null, // INOUT p_sale_id
      );
      const saleId = result?.p_sale_id ?? null;
      req.session.cart = {};
      flash(req, 'success', 'Sale saved.');
      return saleId ? res.redirect(`/orders/${saleId}`) : res.redirect('/orders');
    } catch (error) {
      flash(req, 'error', error.message);
      return res.redirect('/pos');
    }
  });
}