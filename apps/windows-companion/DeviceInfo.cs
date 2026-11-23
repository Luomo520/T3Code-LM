using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Management;
using System.Net.NetworkInformation;
using Microsoft.Win32;

internal static class DeviceInfo
{
    internal static Dictionary<string, string> Read()
    {
        var values = new Dictionary<string, string> {
            { "hostname", Environment.MachineName },
            { "os", Environment.OSVersion.VersionString },
            { "platform", "windows" },
            { "recordingStop", "true" },
            { "version", Program.Version },
            { "processorCount", Environment.ProcessorCount.ToString(CultureInfo.InvariantCulture) }
        };

        try
        {
            Add(values, "cpu", Registry.GetValue(
                @"HKEY_LOCAL_MACHINE\HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString", "") as string);
        }
        catch (System.Security.SecurityException) { }
        catch (UnauthorizedAccessException) { }

        Add(values, "gpu", String.Join(", ", ReadManagementProperties("SELECT Name FROM Win32_VideoController", "Name")));
        foreach (string size in ReadManagementProperties("SELECT TotalPhysicalMemory FROM Win32_ComputerSystem", "TotalPhysicalMemory"))
        {
            ulong bytes;
            if (!UInt64.TryParse(size, NumberStyles.None, CultureInfo.InvariantCulture, out bytes) || bytes == 0) continue;
            Add(values, "memory", (bytes / 1073741824d).ToString("0.#", CultureInfo.InvariantCulture) + " GiB");
            break;
        }

        return WithCurrentNetworks(values);
    }

    internal static Dictionary<string, string> WithCurrentNetworks(Dictionary<string, string> previous)
    {
        var details = previous.Where(field => !field.Key.StartsWith("network", StringComparison.Ordinal))
            .ToDictionary(field => field.Key, field => field.Value);
        try
        {
            var adapters = NetworkInterface.GetAllNetworkInterfaces()
                .Where(adapter => adapter.NetworkInterfaceType != NetworkInterfaceType.Loopback &&
                    adapter.NetworkInterfaceType != NetworkInterfaceType.Tunnel)
                .OrderByDescending(adapter => adapter.OperationalStatus == OperationalStatus.Up)
                .ThenBy(adapter => adapter.Name, StringComparer.OrdinalIgnoreCase)
                .Take(6);
            int index = 0;
            foreach (NetworkInterface adapter in adapters)
            {
                var addresses = adapter.GetIPProperties().UnicastAddresses.Select(entry => entry.Address)
                    .Where(address => !address.IsIPv6LinkLocal)
                    .Take(5)
                    .Select(address => address.ToString());
                string ips = String.Join(", ", addresses);
                byte[] addressBytes = adapter.GetPhysicalAddress().GetAddressBytes();
                var parts = new List<string> { adapter.Description };
                if (!String.IsNullOrEmpty(ips)) parts.Add("IP " + ips);
                if (addressBytes.Length > 0) parts.Add("MAC " + BitConverter.ToString(addressBytes));
                Add(details, "network" + (++index).ToString(CultureInfo.InvariantCulture), String.Join(" · ", parts));
            }
        }
        catch (NetworkInformationException) { }
        return details;
    }

    private static List<string> ReadManagementProperties(string query, string property)
    {
        var values = new List<string>();
        try
        {
            using (var searcher = new ManagementObjectSearcher(query))
            using (var results = searcher.Get())
            {
                foreach (ManagementBaseObject result in results)
                {
                    using (result)
                    {
                        string value = Convert.ToString(result[property], CultureInfo.InvariantCulture);
                        if (!String.IsNullOrWhiteSpace(value)) values.Add(value.Trim());
                    }
                    if (values.Count >= 4) break;
                }
            }
        }
        catch (ManagementException) { }
        catch (System.Runtime.InteropServices.COMException) { }
        catch (UnauthorizedAccessException) { }
        return values;
    }

    private static void Add(Dictionary<string, string> details, string key, string value)
    {
        if (String.IsNullOrWhiteSpace(value)) return;
        value = String.Concat(value.Where(character => !Char.IsControl(character))).Trim();
        if (value.Length > 512) value = value.Substring(0, 511) + "…";
        if (value.Length > 0) details[key] = value;
    }
}
