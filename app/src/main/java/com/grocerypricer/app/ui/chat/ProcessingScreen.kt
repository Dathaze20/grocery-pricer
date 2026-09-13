package com.grocerypricer.app.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.grocerypricer.app.processing.ProcessingStage

/**
 * What the shopkeeper looks at while an order is read.
 *
 * The lines name what is happening to their receipt, not to the software. There is no progress
 * bar with a percentage, because the honest answer to "how far along is it" depends on how many
 * photographs and how busy the provider is, and a bar that lies is worse than a spinner that does
 * not.
 */
@Composable
fun ProcessingScreen(
    stage: ProcessingStage,
    failureMessage: String?,
    onRetry: () -> Unit,
    onUseLocalReader: () -> Unit,
    onCheckPhotos: () -> Unit,
    onBack: () -> Unit,
) {
    Scaffold { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            if (failureMessage == null) {
                CircularProgressIndicator(modifier = Modifier.size(48.dp))

                Text(
                    ProcessingStage.STARTING.message,
                    modifier = Modifier.padding(top = 32.dp),
                    style = MaterialTheme.typography.headlineSmall,
                    textAlign = TextAlign.Center,
                )

                Text(
                    stage.message,
                    modifier = Modifier.padding(top = 12.dp),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )

                Text(
                    "You can leave this screen. I'll keep going and let you know when it's ready.",
                    modifier = Modifier.padding(top = 24.dp),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            } else {
                Text(
                    "I couldn't finish analyzing this order.",
                    style = MaterialTheme.typography.headlineSmall,
                    textAlign = TextAlign.Center,
                )
                Text(
                    failureMessage,
                    modifier = Modifier.padding(top = 12.dp),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )

                // The photographs and their OCR are untouched, so none of this starts over.
                Button(
                    onClick = onRetry,
                    modifier = Modifier.fillMaxWidth().padding(top = 32.dp),
                ) { Text("TRY AGAIN") }

                OutlinedButton(
                    onClick = onUseLocalReader,
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                ) { Text("USE LOCAL RECEIPT READER") }

                OutlinedButton(
                    onClick = onCheckPhotos,
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                ) { Text("CHECK RECEIPT PHOTOS") }

                OutlinedButton(
                    onClick = onBack,
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                ) { Text("Back") }
            }
        }
    }
}
