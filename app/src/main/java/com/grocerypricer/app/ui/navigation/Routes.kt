package com.grocerypricer.app.ui.navigation

object Routes {
    const val TUTORIAL = "tutorial"
    const val HOME = "home"
    const val NEW_ORDER = "new_order"
    const val ORDERS = "orders"

    private const val RECEIPTS_BASE = "receipts"
    private const val REVIEW_BASE = "review"
    private const val ORDER_SUMMARY_BASE = "order_summary"
    private const val PRICE_LIST_BASE = "price_list"
    private const val SCAN_BASE = "scan"
    private const val MANUAL_ITEM_BASE = "manual_item"
    private const val PRODUCT_BASE = "product"

    const val ARG_ORDER_ID = "orderId"
    const val ARG_PRODUCT_ID = "productId"
    const val ARG_CAMERA_MODE = "cameraMode"

    const val RECEIPTS = "$RECEIPTS_BASE/{$ARG_ORDER_ID}"
    const val REVIEW = "$REVIEW_BASE/{$ARG_ORDER_ID}"
    const val ORDER_SUMMARY = "$ORDER_SUMMARY_BASE/{$ARG_ORDER_ID}"
    const val PRICE_LIST = "$PRICE_LIST_BASE/{$ARG_ORDER_ID}"
    const val SCAN = "$SCAN_BASE/{$ARG_ORDER_ID}/{$ARG_CAMERA_MODE}"
    const val MANUAL_ITEM = "$MANUAL_ITEM_BASE/{$ARG_ORDER_ID}"
    const val PRODUCT = "$PRODUCT_BASE/{$ARG_PRODUCT_ID}"

    const val CATALOG = "catalog"
    const val HISTORY = "history"
    const val RULES = "rules"
    const val SETTINGS = "settings"
    const val BACKUP = "backup"

    fun receipts(orderId: Long) = "$RECEIPTS_BASE/$orderId"
    fun review(orderId: Long) = "$REVIEW_BASE/$orderId"
    fun orderSummary(orderId: Long) = "$ORDER_SUMMARY_BASE/$orderId"
    fun priceList(orderId: Long) = "$PRICE_LIST_BASE/$orderId"
    fun scan(orderId: Long, cameraMode: Boolean) = "$SCAN_BASE/$orderId/$cameraMode"
    fun manualItem(orderId: Long) = "$MANUAL_ITEM_BASE/$orderId"
    fun product(productId: Long) = "$PRODUCT_BASE/$productId"
}
