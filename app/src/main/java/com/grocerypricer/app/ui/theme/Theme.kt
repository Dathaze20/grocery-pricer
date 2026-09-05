package com.grocerypricer.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.grocerypricer.app.data.model.ThemeMode

private val DeliGreen = Color(0xFF0F3D2E)
private val DeliGreenLight = Color(0xFF2E7D5B)
private val Amber = Color(0xFFB26A00)
private val AmberLight = Color(0xFFFFB84D)
private val Cream = Color(0xFFFAF7F0)
private val Charcoal = Color(0xFF15181A)

private val LightColors = lightColorScheme(
    primary = DeliGreen,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFB8E7CE),
    onPrimaryContainer = Color(0xFF002114),
    secondary = Amber,
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFFFDDB0),
    onSecondaryContainer = Color(0xFF2A1700),
    background = Cream,
    onBackground = Color(0xFF191C1A),
    surface = Color.White,
    onSurface = Color(0xFF191C1A),
    surfaceVariant = Color(0xFFE3E7E3),
    onSurfaceVariant = Color(0xFF3F4945),
    error = Color(0xFFB3261E),
    onError = Color.White,
    errorContainer = Color(0xFFF9DEDC),
    onErrorContainer = Color(0xFF410E0B),
    outline = Color(0xFF6F7975),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF6FD8A8),
    onPrimary = Color(0xFF003825),
    primaryContainer = DeliGreenLight,
    onPrimaryContainer = Color(0xFFB8E7CE),
    secondary = AmberLight,
    onSecondary = Color(0xFF452B00),
    secondaryContainer = Color(0xFF6B4200),
    onSecondaryContainer = Color(0xFFFFDDB0),
    background = Charcoal,
    onBackground = Color(0xFFE1E3E0),
    surface = Color(0xFF1D2124),
    onSurface = Color(0xFFE1E3E0),
    surfaceVariant = Color(0xFF3F4945),
    onSurfaceVariant = Color(0xFFBFC9C4),
    error = Color(0xFFF2B8B5),
    onError = Color(0xFF601410),
    errorContainer = Color(0xFF8C1D18),
    onErrorContainer = Color(0xFFF9DEDC),
    outline = Color(0xFF899390),
)

/**
 * Type is deliberately a size up from the Material defaults. The app is read at arm's length,
 * one-handed, while walking a shop floor.
 */
private val GroceryTypography = Typography(
    displayLarge = TextStyle(fontSize = 64.sp, lineHeight = 68.sp, fontWeight = FontWeight.Bold),
    displayMedium = TextStyle(fontSize = 48.sp, lineHeight = 52.sp, fontWeight = FontWeight.Bold),
    headlineLarge = TextStyle(fontSize = 32.sp, lineHeight = 40.sp, fontWeight = FontWeight.SemiBold),
    headlineMedium = TextStyle(fontSize = 26.sp, lineHeight = 34.sp, fontWeight = FontWeight.SemiBold),
    headlineSmall = TextStyle(fontSize = 22.sp, lineHeight = 30.sp, fontWeight = FontWeight.SemiBold),
    titleLarge = TextStyle(fontSize = 21.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 18.sp, lineHeight = 26.sp, fontWeight = FontWeight.Medium),
    bodyLarge = TextStyle(fontSize = 18.sp, lineHeight = 26.sp),
    bodyMedium = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
    bodySmall = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    labelLarge = TextStyle(fontSize = 17.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
    labelMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
)

@Composable
fun GroceryPricerTheme(
    themeMode: ThemeMode = ThemeMode.SYSTEM,
    content: @Composable () -> Unit,
) {
    val dark = when (themeMode) {
        ThemeMode.SYSTEM -> isSystemInDarkTheme()
        ThemeMode.LIGHT -> false
        ThemeMode.DARK -> true
    }
    MaterialTheme(
        colorScheme = if (dark) DarkColors else LightColors,
        typography = GroceryTypography,
        content = content,
    )
}
