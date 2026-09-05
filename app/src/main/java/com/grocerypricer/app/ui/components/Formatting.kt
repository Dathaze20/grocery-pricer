package com.grocerypricer.app.ui.components

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val DATE_FORMAT = SimpleDateFormat("MMM d yyyy", Locale.US)
private val DATE_TIME_FORMAT = SimpleDateFormat("MMM d yyyy, h:mm a", Locale.US)
private val ISO_DATE_FORMAT = SimpleDateFormat("yyyy-MM-dd", Locale.US)

fun formatDate(millis: Long?): String = millis?.let { DATE_FORMAT.format(Date(it)) } ?: "-"

fun formatDateTime(millis: Long?): String = millis?.let { DATE_TIME_FORMAT.format(Date(it)) } ?: "-"

fun formatIsoDate(millis: Long): String = ISO_DATE_FORMAT.format(Date(millis))
