/* Mesa's Venus encoders and decoders, as an oracle for venus_protocol.js
 * (tools/venus_protocol_gen.mjs; tests/devices/venus_protocol.js keeps what
 * it printed):
 *   oracle requests        -> one line per request: name hex
 *   oracle replies < file  -> decodes "name hex" lines with Mesa's reply decoders, prints what it read
 *
 * cc -std=gnu11 -w -I tools/venus_oracle/stub -I $MESA/src/virtio/venus-protocol -I $MESA/include \
 *     -o oracle tools/venus_oracle/oracle.c
 */
#include <stdio.h>
#include "vn_protocol_driver.h"

static uint8_t buf[1 << 16];

static void dump(const char *name, struct vn_cs_encoder *enc)
{
   printf("%s ", name);
   for (uint8_t *p = enc->base; p < enc->cur; p++) printf("%02x", *p);
   printf("\n");
}

#define ENC(enc) struct vn_cs_encoder enc = { buf, buf, buf + sizeof(buf) }
#define H(x) ((void *)(uintptr_t)(x))

static void requests(void)
{
   {
      ENC(enc);
      const char *exts[] = { "VK_KHR_surface", "VK_EXT_debug_utils" };
      VkApplicationInfo app = { .sType = VK_STRUCTURE_TYPE_APPLICATION_INFO, .pApplicationName = "vktest", .applicationVersion = 7,
                                .pEngineName = NULL, .engineVersion = 0, .apiVersion = VK_API_VERSION_1_3 };
      VkInstanceCreateInfo info = { .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, .pApplicationInfo = &app,
                                    .enabledExtensionCount = 2, .ppEnabledExtensionNames = exts };
      VkInstance instance = H(0x1234);
      vn_encode_vkCreateInstance(&enc, VK_COMMAND_GENERATE_REPLY_BIT_EXT, &info, NULL, &instance);
      dump("vkCreateInstance", &enc);
   }
   {
      ENC(enc);
      uint32_t count = 2;
      VkPhysicalDevice devices[2] = { H(0x10), H(0x11) };
      vn_encode_vkEnumeratePhysicalDevices(&enc, VK_COMMAND_GENERATE_REPLY_BIT_EXT, H(0x1234), &count, devices);
      dump("vkEnumeratePhysicalDevices", &enc);
   }
   {
      ENC(enc);
      VkPhysicalDeviceVulkan11Properties v11 = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_1_PROPERTIES };
      VkPhysicalDeviceDriverProperties driver = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DRIVER_PROPERTIES, .pNext = &v11 };
      VkPhysicalDeviceProperties2 props = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2, .pNext = &driver };
      vn_encode_vkGetPhysicalDeviceProperties2(&enc, VK_COMMAND_GENERATE_REPLY_BIT_EXT, H(0x10), &props);
      dump("vkGetPhysicalDeviceProperties2", &enc);
   }
   {
      ENC(enc);
      VkPhysicalDeviceVulkan12Features f12 = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES, .timelineSemaphore = 1 };
      VkPhysicalDeviceFeatures2 f2 = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2, .pNext = &f12,
                                       .features = { .robustBufferAccess = 1, .samplerAnisotropy = 1 } };
      float priorities[2] = { 1.0f, 0.5f };
      VkDeviceQueueCreateInfo queue = { .sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO, .queueFamilyIndex = 0,
                                        .queueCount = 2, .pQueuePriorities = priorities };
      const char *exts[] = { "VK_KHR_swapchain" };
      VkDeviceCreateInfo info = { .sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, .pNext = &f2, .queueCreateInfoCount = 1,
                                  .pQueueCreateInfos = &queue, .enabledExtensionCount = 1, .ppEnabledExtensionNames = exts };
      VkDevice device = H(0x20);
      vn_encode_vkCreateDevice(&enc, VK_COMMAND_GENERATE_REPLY_BIT_EXT, H(0x10), &info, NULL, &device);
      dump("vkCreateDevice", &enc);
   }
   {
      ENC(enc);
      uint32_t families[2] = { 0, 3 };
      VkBufferCreateInfo info = { .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, .size = 0x100000005ull,
                                  .usage = VK_BUFFER_USAGE_VERTEX_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT,
                                  .sharingMode = VK_SHARING_MODE_CONCURRENT, .queueFamilyIndexCount = 2, .pQueueFamilyIndices = families };
      VkBuffer buffer = (VkBuffer)0x30;
      vn_encode_vkCreateBuffer(&enc, 0, H(0x20), &info, NULL, &buffer);
      dump("vkCreateBuffer", &enc);
   }
   {
      ENC(enc);
      VkClearValue clears[2] = { { .color = { .float32 = { 0.25f, 0.5f, 0.75f, 1.0f } } },
                                 { .depthStencil = { .depth = 1.0f, .stencil = 0x80 } } };
      VkRenderPassBeginInfo info = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO, .renderPass = (VkRenderPass)0x40,
                                     .framebuffer = (VkFramebuffer)0x41, .renderArea = { { 1, 2 }, { 640, 480 } },
                                     .clearValueCount = 2, .pClearValues = clears };
      vn_encode_vkCmdBeginRenderPass(&enc, 0, H(0x50), &info, VK_SUBPASS_CONTENTS_INLINE);
      dump("vkCmdBeginRenderPass", &enc);
   }
   {
      ENC(enc);
      VkDescriptorImageInfo images[2] = { { (VkSampler)0x60, (VkImageView)0x61, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL },
                                          { (VkSampler)0x62, (VkImageView)0x63, VK_IMAGE_LAYOUT_GENERAL } };
      VkDescriptorBufferInfo buffers[1] = { { (VkBuffer)0x30, 256, VK_WHOLE_SIZE } };
      VkWriteDescriptorSet writes[2] = {
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = (VkDescriptorSet)0x70, .dstBinding = 1, .dstArrayElement = 0,
           .descriptorCount = 2, .descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, .pImageInfo = images },
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = (VkDescriptorSet)0x70, .dstBinding = 0,
           .descriptorCount = 1, .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, .pBufferInfo = buffers },
      };
      VkCopyDescriptorSet copy = { .sType = VK_STRUCTURE_TYPE_COPY_DESCRIPTOR_SET, .srcSet = (VkDescriptorSet)0x70, .srcBinding = 1,
                                   .dstSet = (VkDescriptorSet)0x71, .dstBinding = 2, .descriptorCount = 1 };
      vn_encode_vkUpdateDescriptorSets(&enc, 0, H(0x20), 2, writes, 1, &copy);
      dump("vkUpdateDescriptorSets", &enc);
   }
   {
      ENC(enc);
      const uint8_t values[12] = { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 };
      vn_encode_vkCmdPushConstants(&enc, 0, H(0x50), (VkPipelineLayout)0x80, VK_SHADER_STAGE_VERTEX_BIT, 4, 12, values);
      dump("vkCmdPushConstants", &enc);
   }
   {
      ENC(enc);
      const uint32_t code[5] = { 0x07230203, 0x00010000, 0x00080001, 0x0000000d, 0 };
      VkShaderModuleCreateInfo info = { .sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO, .codeSize = 20, .pCode = code };
      VkShaderModule module = (VkShaderModule)0x90;
      vn_encode_vkCreateShaderModule(&enc, 0, H(0x20), &info, NULL, &module);
      dump("vkCreateShaderModule", &enc);
   }
   {
      ENC(enc);
      VkSemaphore waits[2] = { (VkSemaphore)0xa0, (VkSemaphore)0xa1 };
      VkPipelineStageFlags stages[2] = { VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT };
      VkCommandBuffer cmds[1] = { H(0x50) };
      VkSemaphore signals[1] = { (VkSemaphore)0xa2 };
      uint64_t wait_values[2] = { 5, 0x123456789ull }, signal_values[1] = { 6 };
      VkTimelineSemaphoreSubmitInfo timeline = { .sType = VK_STRUCTURE_TYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO,
                                                 .waitSemaphoreValueCount = 2, .pWaitSemaphoreValues = wait_values,
                                                 .signalSemaphoreValueCount = 1, .pSignalSemaphoreValues = signal_values };
      VkSubmitInfo submit = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .pNext = &timeline, .waitSemaphoreCount = 2, .pWaitSemaphores = waits,
                              .pWaitDstStageMask = stages, .commandBufferCount = 1, .pCommandBuffers = cmds,
                              .signalSemaphoreCount = 1, .pSignalSemaphores = signals };
      vn_encode_vkQueueSubmit(&enc, 0, H(0xb0), 1, &submit, (VkFence)0xc0);
      dump("vkQueueSubmit", &enc);
   }
   {
      ENC(enc);
      VkSpecializationMapEntry entries[2] = { { 0, 0, 4 }, { 1, 4, 4 } };
      const uint32_t spec_data[2] = { 7, 9 };
      VkSpecializationInfo spec = { 2, entries, 8, spec_data };
      VkPipelineShaderStageCreateInfo stages[2] = {
         { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_VERTEX_BIT, .module = (VkShaderModule)0x90, .pName = "main" },
         { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_FRAGMENT_BIT, .module = (VkShaderModule)0x91,
           .pName = "fs_main", .pSpecializationInfo = &spec },
      };
      VkVertexInputBindingDescription bindings[1] = { { 0, 20, VK_VERTEX_INPUT_RATE_VERTEX } };
      VkVertexInputAttributeDescription attributes[2] = { { 0, 0, VK_FORMAT_R32G32B32_SFLOAT, 0 }, { 1, 0, VK_FORMAT_R32G32_SFLOAT, 12 } };
      VkPipelineVertexInputStateCreateInfo vertex = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO,
                                                      .vertexBindingDescriptionCount = 1, .pVertexBindingDescriptions = bindings,
                                                      .vertexAttributeDescriptionCount = 2, .pVertexAttributeDescriptions = attributes };
      VkPipelineInputAssemblyStateCreateInfo assembly = { .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
                                                          .topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_STRIP, .primitiveRestartEnable = 1 };
      VkPipelineViewportStateCreateInfo viewport = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO, .viewportCount = 1, .scissorCount = 1 };
      VkPipelineRasterizationStateCreateInfo raster = { .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
                                                        .polygonMode = VK_POLYGON_MODE_FILL, .cullMode = VK_CULL_MODE_BACK_BIT,
                                                        .frontFace = VK_FRONT_FACE_CLOCKWISE, .lineWidth = 1.0f };
      VkSampleMask mask = 0xF;
      VkPipelineMultisampleStateCreateInfo ms = { .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
                                                  .rasterizationSamples = VK_SAMPLE_COUNT_4_BIT, .pSampleMask = &mask };
      VkPipelineDepthStencilStateCreateInfo ds = { .sType = VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO,
                                                   .depthTestEnable = 1, .depthWriteEnable = 1, .depthCompareOp = VK_COMPARE_OP_LESS_OR_EQUAL,
                                                   .front = { .failOp = VK_STENCIL_OP_KEEP, .passOp = VK_STENCIL_OP_REPLACE, .compareOp = VK_COMPARE_OP_ALWAYS, .reference = 3 },
                                                   .maxDepthBounds = 1.0f };
      VkPipelineColorBlendAttachmentState blend_attachment = { .blendEnable = 1, .srcColorBlendFactor = VK_BLEND_FACTOR_SRC_ALPHA,
                                                               .dstColorBlendFactor = VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA,
                                                               .colorWriteMask = 0xF };
      VkPipelineColorBlendStateCreateInfo blend = { .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO,
                                                    .attachmentCount = 1, .pAttachments = &blend_attachment,
                                                    .blendConstants = { 0.1f, 0.2f, 0.3f, 0.4f } };
      VkDynamicState dynamic_states[2] = { VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR };
      VkPipelineDynamicStateCreateInfo dynamic = { .sType = VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO,
                                                   .dynamicStateCount = 2, .pDynamicStates = dynamic_states };
      VkGraphicsPipelineCreateInfo info = { .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, .stageCount = 2, .pStages = stages,
                                            .pVertexInputState = &vertex, .pInputAssemblyState = &assembly, .pViewportState = &viewport,
                                            .pRasterizationState = &raster, .pMultisampleState = &ms, .pDepthStencilState = &ds,
                                            .pColorBlendState = &blend, .pDynamicState = &dynamic, .layout = (VkPipelineLayout)0x80,
                                            .renderPass = (VkRenderPass)0x40, .subpass = 0, .basePipelineIndex = -1 };
      VkPipeline pipeline = (VkPipeline)0xd0;
      vn_encode_vkCreateGraphicsPipelines(&enc, 0, H(0x20), (VkPipelineCache)0, 1, &info, NULL, &pipeline);
      dump("vkCreateGraphicsPipelines", &enc);
   }
   {
      ENC(enc);
      VkRingMonitorInfoMESA monitor = { .sType = VK_STRUCTURE_TYPE_RING_MONITOR_INFO_MESA, .maxReportingPeriodMicroseconds = 3000000 };
      VkRingCreateInfoMESA info = { .sType = VK_STRUCTURE_TYPE_RING_CREATE_INFO_MESA, .pNext = &monitor, .resourceId = 9,
                                    .size = 0x20140, .idleTimeout = 1000000, .headOffset = 0, .tailOffset = 64, .statusOffset = 128,
                                    .bufferOffset = 192, .bufferSize = 0x20000, .extraOffset = 0x200c0, .extraSize = 0x80 };
      vn_encode_vkCreateRingMESA(&enc, 0, 0x7f0012345678ull, &info);
      dump("vkCreateRingMESA", &enc);
   }
   {
      ENC(enc);
      struct { VkMultiDrawInfoEXT info; uint32_t pad; } draws[2] = { { { 3, 6 } }, { { 10, 4 } } };
      vn_encode_vkCmdDrawMultiEXT(&enc, 0, H(0x50), 2, &draws[0].info, 1, 0, sizeof(draws[0]));
      dump("vkCmdDrawMultiEXT", &enc);
   }
   {
      ENC(enc);
      const float constants[4] = { 1, 0.5f, 0.25f, 0 };
      vn_encode_vkCmdSetBlendConstants(&enc, 0, H(0x50), constants);
      dump("vkCmdSetBlendConstants", &enc);
   }
   {
      ENC(enc);
      uint8_t data[32];
      vn_encode_vkGetQueryPoolResults(&enc, VK_COMMAND_GENERATE_REPLY_BIT_EXT, H(0x20), (VkQueryPool)0xe0, 1, 2, 32, data, 16,
                                      VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT);
      dump("vkGetQueryPoolResults", &enc);
   }
   {
      ENC(enc);
      VkDescriptorSetLayout layouts[2] = { (VkDescriptorSetLayout)0xf0, (VkDescriptorSetLayout)0xf1 };
      VkDescriptorSetAllocateInfo info = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO, .descriptorPool = (VkDescriptorPool)0xf2,
                                           .descriptorSetCount = 2, .pSetLayouts = layouts };
      VkDescriptorSet sets[2] = { (VkDescriptorSet)0x100, (VkDescriptorSet)0x101 };
      vn_encode_vkAllocateDescriptorSets(&enc, 0, H(0x20), &info, sets);
      dump("vkAllocateDescriptorSets", &enc);
   }
   {
      ENC(enc);
      uint32_t count = 3;
      VkQueueFamilyProperties2 props[3];
      for (int i = 0; i < 3; i++) props[i] = (VkQueueFamilyProperties2){ .sType = VK_STRUCTURE_TYPE_QUEUE_FAMILY_PROPERTIES_2 };
      vn_encode_vkGetPhysicalDeviceQueueFamilyProperties2(&enc, VK_COMMAND_GENERATE_REPLY_BIT_EXT, H(0x10), &count, props);
      dump("vkGetPhysicalDeviceQueueFamilyProperties2", &enc);
   }
}

static size_t unhex(const char *hex, uint8_t *out)
{
   size_t n = 0;
   for (; hex[0] && hex[1] && hex[0] != '\n'; hex += 2) {
      unsigned v;
      sscanf(hex, "%2x", &v);
      out[n++] = v;
   }
   return n;
}

#define DEC(dec, bytes, n) struct vn_cs_decoder dec = { bytes, bytes + n, false }
#define END(dec) printf(" fatal=%d left=%d\n", dec.fatal, (int)(dec.end - dec.cur))

static void replies(void)
{
   char line[1 << 17];
   static uint8_t bytes[1 << 16];
   while (fgets(line, sizeof(line), stdin)) {
      char name[128];
      if (sscanf(line, "%127s", name) != 1) continue;
      const size_t n = unhex(line + strlen(name) + 1, bytes);
      printf("%s", name);
      if (!strcmp(name, "vkEnumeratePhysicalDevices")) {
         DEC(dec, bytes, n);
         uint32_t count = 2;
         VkPhysicalDevice devices[2] = { 0 };
         VkResult r = vn_decode_vkEnumeratePhysicalDevices_reply(&dec, NULL, &count, devices);
         printf(" ret=%d count=%u devices=%lx,%lx", r, count, (unsigned long)(uintptr_t)devices[0], (unsigned long)(uintptr_t)devices[1]);
         END(dec);
      } else if (!strcmp(name, "vkGetPhysicalDeviceProperties2")) {
         DEC(dec, bytes, n);
         VkPhysicalDeviceVulkan11Properties v11 = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_1_PROPERTIES };
         VkPhysicalDeviceDriverProperties driver = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DRIVER_PROPERTIES, .pNext = &v11 };
         VkPhysicalDeviceProperties2 props = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2, .pNext = &driver };
         vn_decode_vkGetPhysicalDeviceProperties2_reply(&dec, NULL, &props);
         printf(" api=%x vendor=%x name=%s type=%d maxImage2D=%u pointSize=%g,%g uuid0=%d driverID=%d driverName=%s conformance=%d.%d"
                " deviceUUID=%d,%d subgroupSize=%u maxMultiviewViewCount=%u",
                props.properties.apiVersion, props.properties.vendorID, props.properties.deviceName, props.properties.deviceType,
                props.properties.limits.maxImageDimension2D, props.properties.limits.pointSizeRange[0], props.properties.limits.pointSizeRange[1],
                props.properties.pipelineCacheUUID[0], driver.driverID, driver.driverName, driver.conformanceVersion.major,
                driver.conformanceVersion.minor, v11.deviceUUID[0], v11.deviceUUID[15], v11.subgroupSize, v11.maxMultiviewViewCount);
         END(dec);
      } else if (!strcmp(name, "vkGetPhysicalDeviceMemoryProperties")) {
         DEC(dec, bytes, n);
         VkPhysicalDeviceMemoryProperties props;
         vn_decode_vkGetPhysicalDeviceMemoryProperties_reply(&dec, NULL, &props);
         printf(" types=%u [%x/%u %x/%u] heaps=%u [%llx/%x]", props.memoryTypeCount, props.memoryTypes[0].propertyFlags,
                props.memoryTypes[0].heapIndex, props.memoryTypes[1].propertyFlags, props.memoryTypes[1].heapIndex,
                props.memoryHeapCount, (unsigned long long)props.memoryHeaps[0].size, props.memoryHeaps[0].flags);
         END(dec);
      } else if (!strcmp(name, "vkCreateBuffer")) {
         DEC(dec, bytes, n);
         VkBuffer buffer = 0;
         VkResult r = vn_decode_vkCreateBuffer_reply(&dec, NULL, NULL, NULL, &buffer);
         printf(" ret=%d buffer=%llx", r, (unsigned long long)buffer);
         END(dec);
      } else if (!strcmp(name, "vkEnumerateInstanceExtensionProperties")) {
         DEC(dec, bytes, n);
         uint32_t count = 2;
         VkExtensionProperties props[2];
         VkResult r = vn_decode_vkEnumerateInstanceExtensionProperties_reply(&dec, NULL, &count, props);
         printf(" ret=%d count=%u %s/%u %s/%u", r, count, props[0].extensionName, props[0].specVersion, props[1].extensionName, props[1].specVersion);
         END(dec);
      } else if (!strcmp(name, "vkGetQueryPoolResults")) {
         DEC(dec, bytes, n);
         uint64_t data[4] = { 0 };
         VkResult r = vn_decode_vkGetQueryPoolResults_reply(&dec, NULL, 0, 1, 2, 32, data, 16, 0);
         printf(" ret=%d data=%llx,%llx,%llx,%llx", r, (unsigned long long)data[0], (unsigned long long)data[1],
                (unsigned long long)data[2], (unsigned long long)data[3]);
         END(dec);
      } else if (!strcmp(name, "vkGetBufferDeviceAddress")) {
         DEC(dec, bytes, n);
         VkBufferDeviceAddressInfo info = { .sType = VK_STRUCTURE_TYPE_BUFFER_DEVICE_ADDRESS_INFO };
         VkDeviceAddress a = vn_decode_vkGetBufferDeviceAddress_reply(&dec, NULL, &info);
         printf(" address=%llx", (unsigned long long)a);
         END(dec);
      } else if (!strcmp(name, "vkGetPhysicalDeviceQueueFamilyProperties2")) {
         DEC(dec, bytes, n);
         uint32_t count = 3;
         VkQueueFamilyProperties2 props[3];
         for (int i = 0; i < 3; i++) props[i] = (VkQueueFamilyProperties2){ .sType = VK_STRUCTURE_TYPE_QUEUE_FAMILY_PROPERTIES_2 };
         vn_decode_vkGetPhysicalDeviceQueueFamilyProperties2_reply(&dec, NULL, &count, props);
         printf(" count=%u flags=%x queues=%u bits=%u granularity=%u,%u,%u", count, props[0].queueFamilyProperties.queueFlags,
                props[0].queueFamilyProperties.queueCount, props[0].queueFamilyProperties.timestampValidBits,
                props[0].queueFamilyProperties.minImageTransferGranularity.width,
                props[0].queueFamilyProperties.minImageTransferGranularity.height,
                props[0].queueFamilyProperties.minImageTransferGranularity.depth);
         END(dec);
      } else {
         printf(" unknown\n");
      }
   }
}

int main(int argc, char **argv)
{
   if (argc > 1 && !strcmp(argv[1], "requests")) requests();
   else if (argc > 1 && !strcmp(argv[1], "replies")) replies();
   else return 1;
   return 0;
}
