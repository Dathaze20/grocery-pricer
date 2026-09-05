package com.grocerypricer.app.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.grocerypricer.core.model.ItemConfidence
import com.grocerypricer.core.money.Money

/** A full-width, thumb-sized button. Everything primary in this app uses one. */
@Composable
fun BigActionButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    enabled: Boolean = true,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.fillMaxWidth().heightIn(min = 64.dp),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(28.dp))
            Spacer(Modifier.width(12.dp))
        }
        Text(text, style = MaterialTheme.typography.titleLarge)
    }
}

@Composable
fun SecondaryActionButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    enabled: Boolean = true,
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.fillMaxWidth().heightIn(min = 56.dp),
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(24.dp))
            Spacer(Modifier.width(10.dp))
        }
        Text(text, style = MaterialTheme.typography.titleMedium)
    }
}

/** One number and its label, for the dashboard summary row. */
@Composable
fun StatCard(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    highlight: Boolean = false,
) {
    Card(
        modifier = modifier,
        colors = CardDefaults.cardColors(
            containerColor = if (highlight) {
                MaterialTheme.colorScheme.secondaryContainer
            } else {
                MaterialTheme.colorScheme.surface
            },
        ),
    ) {
        Column(Modifier.padding(16.dp)) {
            Text(value, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(4.dp))
            Text(
                label,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
fun SectionCard(
    title: String,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Card(modifier = modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(12.dp))
            content()
        }
    }
}

@Composable
fun LabelledValue(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    emphasise: Boolean = false,
    valueColor: Color? = null,
) {
    Row(
        modifier = modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            value,
            style = if (emphasise) MaterialTheme.typography.titleLarge else MaterialTheme.typography.bodyLarge,
            fontWeight = if (emphasise) FontWeight.Bold else FontWeight.Normal,
            color = valueColor ?: MaterialTheme.colorScheme.onSurface,
        )
    }
}

/** The number the employee is actually looking for, at a size that reads from arm's length. */
@Composable
fun BigPrice(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    color: Color? = null,
) {
    Column(modifier = modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            label.uppercase(),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        Text(
            value,
            style = MaterialTheme.typography.displayMedium,
            color = color ?: MaterialTheme.colorScheme.onSurface,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
fun ConfidenceChip(confidence: ItemConfidence, modifier: Modifier = Modifier) {
    val container: Color
    val content: Color
    when (confidence) {
        ItemConfidence.HIGH -> {
            container = MaterialTheme.colorScheme.primaryContainer
            content = MaterialTheme.colorScheme.onPrimaryContainer
        }
        ItemConfidence.NEEDS_REVIEW -> {
            container = MaterialTheme.colorScheme.secondaryContainer
            content = MaterialTheme.colorScheme.onSecondaryContainer
        }
        ItemConfidence.PROBLEM -> {
            container = MaterialTheme.colorScheme.errorContainer
            content = MaterialTheme.colorScheme.onErrorContainer
        }
    }
    Surface(color = container, shape = MaterialTheme.shapes.small, modifier = modifier) {
        Text(
            confidence.displayName,
            style = MaterialTheme.typography.labelMedium,
            color = content,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }
}

@Composable
fun WarningBanner(message: String, modifier: Modifier = Modifier) {
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        shape = MaterialTheme.shapes.medium,
        modifier = modifier.fillMaxWidth(),
    ) {
        Text(
            message,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onErrorContainer,
            modifier = Modifier.padding(12.dp),
        )
    }
}

@Composable
fun InfoBanner(message: String, modifier: Modifier = Modifier) {
    Surface(
        color = MaterialTheme.colorScheme.secondaryContainer,
        shape = MaterialTheme.shapes.medium,
        modifier = modifier.fillMaxWidth(),
    ) {
        Text(
            message,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSecondaryContainer,
            modifier = Modifier.padding(12.dp),
        )
    }
}

@Composable
fun EmptyState(
    title: String,
    message: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    Column(
        modifier = modifier.fillMaxWidth().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (icon != null) {
            Icon(
                icon,
                contentDescription = null,
                modifier = Modifier.size(56.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(16.dp))
        }
        Text(title, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
        Spacer(Modifier.height(8.dp))
        Text(
            message,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        if (actionLabel != null && onAction != null) {
            Spacer(Modifier.height(20.dp))
            BigActionButton(actionLabel, onAction)
        }
    }
}

@Composable
fun ConfirmDialog(
    title: String,
    message: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    destructive: Boolean = false,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(message) },
        confirmButton = {
            TextButton(
                onClick = {
                    onConfirm()
                    onDismiss()
                },
                colors = if (destructive) {
                    ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)
                } else {
                    ButtonDefaults.textButtonColors()
                },
            ) { Text(confirmLabel) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** A text field for a dollar amount. Keeps the raw string so a half-typed number is not eaten. */
@Composable
fun MoneyField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    supportingText: String? = null,
    isError: Boolean = false,
) {
    OutlinedTextField(
        value = value,
        onValueChange = { text -> onValueChange(text.filter { it.isDigit() || it == '.' }) },
        label = { Text(label) },
        prefix = { Text("$") },
        singleLine = true,
        isError = isError,
        supportingText = supportingText?.let { { Text(it) } },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        modifier = modifier.fillMaxWidth(),
        textStyle = MaterialTheme.typography.titleMedium,
    )
}

@Composable
fun WholeNumberField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    supportingText: String? = null,
    isError: Boolean = false,
) {
    OutlinedTextField(
        value = value,
        onValueChange = { text -> onValueChange(text.filter { it.isDigit() }) },
        label = { Text(label) },
        singleLine = true,
        isError = isError,
        supportingText = supportingText?.let { { Text(it) } },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        modifier = modifier.fillMaxWidth(),
        textStyle = MaterialTheme.typography.titleMedium,
    )
}

@Composable
fun PlainTextField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    singleLine: Boolean = true,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        singleLine = singleLine,
        modifier = modifier.fillMaxWidth(),
        textStyle = MaterialTheme.typography.titleMedium,
    )
}

/** Parses a money field's text, returning null when it is empty or not a number yet. */
fun parseMoneyInput(text: String): Money? = Money.parseOrNull(text)

@Composable
fun QuickPriceRow(
    prices: List<Money>,
    onPick: (Money) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        prices.take(4).forEach { price ->
            OutlinedButton(
                onClick = { onPick(price) },
                modifier = Modifier.weight(1f).heightIn(min = 56.dp),
                contentPadding = PaddingValues(4.dp),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Text(price.format(), style = MaterialTheme.typography.titleMedium, maxLines = 1)
                }
            }
        }
    }
}
