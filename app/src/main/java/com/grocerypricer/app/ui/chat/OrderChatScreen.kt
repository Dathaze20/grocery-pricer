package com.grocerypricer.app.ui.chat

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.grocerypricer.app.data.model.ChatRole
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.app.ui.camera.rememberPhotoCapture
import com.grocerypricer.app.ui.components.InfoBanner

/**
 * The main screen of Grocery Pricer V2.
 *
 * One order, one conversation. The header says what the order is and gets out of the way; below
 * it, the whole product is a text box and an answer. The deliberate absence here is any list of
 * products to work through - that was V1, and removing it is the point.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OrderChatScreen(
    container: AppContainer,
    orderId: Long,
    onBack: () -> Unit,
    onOrderDetails: (Long) -> Unit,
    onCheckReceiptData: (Long) -> Unit,
    onReceiptPhotos: (Long) -> Unit,
    onScan: (Long) -> Unit,
    onAiSetup: () -> Unit,
) {
    val viewModel: OrderChatViewModel =
        viewModel(factory = OrderChatViewModel.factory(container, orderId))
    val state by viewModel.state.collectAsStateWithLifecycle()

    var draft by remember { mutableStateOf("") }
    var menuOpen by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()

    val galleryPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri -> uri?.let(viewModel::attach) }

    // The one that matters in the shop: photograph what is in your hand, right now, without
    // going through the gallery first.
    val takePhoto = rememberPhotoCapture(
        imageStore = container.imageStore,
        orderId = orderId,
    ) { file -> viewModel.attachFile(file.absolutePath) }

    // A new message should bring itself into view rather than waiting to be scrolled to.
    LaunchedEffect(state.messages.size) {
        if (state.messages.isNotEmpty()) listState.animateScrollToItem(state.messages.lastIndex)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            state.order?.name?.takeIf { it.isNotBlank() } ?: "Order",
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Text(
                            buildString {
                                append(state.itemCount).append(" products")
                                state.order?.supplier?.takeIf { it.isNotBlank() }?.let {
                                    append(" • ").append(it)
                                }
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    // Everything technical lives behind this one button. It is all still here;
                    // it just no longer decides what the app looks like.
                    IconButton(onClick = { menuOpen = true }) {
                        Icon(Icons.Default.MoreVert, contentDescription = "More")
                    }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(
                            text = { Text("Order details") },
                            onClick = { menuOpen = false; onOrderDetails(orderId) },
                        )
                        DropdownMenuItem(
                            text = { Text("Check receipt data") },
                            onClick = { menuOpen = false; onCheckReceiptData(orderId) },
                        )
                        DropdownMenuItem(
                            text = { Text("Receipt photos") },
                            onClick = { menuOpen = false; onReceiptPhotos(orderId) },
                        )
                        DropdownMenuItem(
                            text = { Text("Scan a barcode") },
                            onClick = { menuOpen = false; onScan(orderId) },
                        )
                    }
                },
            )
        },
        bottomBar = {
            ChatInputBar(
                draft = draft,
                onDraftChange = { draft = it },
                attachmentPath = state.attachmentPath,
                sending = state.sending,
                onClearAttachment = viewModel::clearAttachment,
                onTakePhoto = takePhoto,
                onPickPhoto = {
                    galleryPicker.launch(
                        PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                    )
                },
                onSend = {
                    viewModel.send(draft)
                    draft = ""
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            if (!state.aiConfigured) {
                InfoBanner(
                    "AI setup is required once before Grocery Pricer can analyze receipt photos.",
                    modifier = Modifier
                        .padding(horizontal = 16.dp, vertical = 8.dp)
                        .clickable(onClick = onAiSetup),
                )
            }

            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize().weight(1f),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(state.messages.size) { index ->
                    val message = state.messages[index]
                    ChatBubble(
                        text = message.text,
                        fromUser = message.role == ChatRole.USER,
                        hasPhoto = message.attachedImagePath != null,
                    )
                }
                if (state.workingMessage != null) {
                    item { WorkingIndicator(state.workingMessage!!) }
                }
            }
        }
    }
}

/**
 * One line of the conversation.
 *
 * Answers are plain text on purpose. The mandated shape - a name, then cost and shelf price - is
 * already two short lines, and wrapping it in a card would make it slower to read, not faster.
 */
@Composable
private fun ChatBubble(text: String, fromUser: Boolean, hasPhoto: Boolean) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (fromUser) Arrangement.End else Arrangement.Start,
    ) {
        Surface(
            color = if (fromUser) {
                MaterialTheme.colorScheme.primaryContainer
            } else {
                MaterialTheme.colorScheme.surfaceVariant
            },
            shape = RoundedCornerShape(
                topStart = 16.dp,
                topEnd = 16.dp,
                bottomStart = if (fromUser) 16.dp else 4.dp,
                bottomEnd = if (fromUser) 4.dp else 16.dp,
            ),
            // Never full width: a bubble that reaches both edges stops reading as speech.
            modifier = Modifier.widthIn(max = 320.dp),
        ) {
            Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                if (hasPhoto) {
                    Text(
                        "📷 Photo attached",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(
                    text.ifBlank { "(no text)" },
                    style = MaterialTheme.typography.bodyLarge,
                    color = if (fromUser) {
                        MaterialTheme.colorScheme.onPrimaryContainer
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
            }
        }
    }
}

/** Says what is happening in the user's terms. Never "calling the API". */
@Composable
private fun WorkingIndicator(message: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
        Text(
            message,
            modifier = Modifier.padding(start = 12.dp),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ChatInputBar(
    draft: String,
    onDraftChange: (String) -> Unit,
    attachmentPath: String?,
    sending: Boolean,
    onClearAttachment: () -> Unit,
    onTakePhoto: () -> Unit,
    onPickPhoto: () -> Unit,
    onSend: () -> Unit,
) {
    Surface(tonalElevation = 3.dp) {
        Column(modifier = Modifier.navigationBarsPadding().imePadding()) {
            HorizontalDivider()

            if (attachmentPath != null) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.secondaryContainer)
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "Photo attached - ask what it is, or \"how much are these three?\"",
                        modifier = Modifier.weight(1f),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSecondaryContainer,
                    )
                    IconButton(onClick = onClearAttachment) {
                        Icon(Icons.Default.Close, contentDescription = "Remove the attached photo")
                    }
                }
            }

            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                // Camera first, because that is the fast path standing at the shelf.
                IconButton(
                    onClick = onTakePhoto,
                    modifier = Modifier.semantics { contentDescription = "Take a photo" },
                ) {
                    Icon(Icons.Default.PhotoCamera, contentDescription = null)
                }

                IconButton(
                    onClick = onPickPhoto,
                    modifier = Modifier.semantics { contentDescription = "Choose an existing photo" },
                ) {
                    Icon(Icons.Default.PhotoLibrary, contentDescription = null)
                }

                OutlinedTextField(
                    value = draft,
                    onValueChange = onDraftChange,
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Ask about this order...") },
                    maxLines = 4,
                )

                IconButton(
                    onClick = onSend,
                    enabled = !sending && (draft.isNotBlank() || attachmentPath != null),
                    modifier = Modifier.semantics { contentDescription = "Send" },
                ) {
                    Icon(Icons.Default.Send, contentDescription = null)
                }
            }
        }
    }
}
